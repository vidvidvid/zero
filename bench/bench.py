#!/usr/bin/env python3
"""Editor benchmark: launch cost, memory, idle CPU.

Processes are attributed by diffing the process table around launch, so an
app's out-of-bundle helpers (WebKit content processes for zero, which live in
/System, not in the app) are counted the same as in-bundle ones (Electron
helpers for Cursor). Anything already running is excluded.

CPU is measured as a *rate*: the delta of cumulative CPU time over a wall
interval, in units of one core. `ps %CPU` can't do this — it reports an average
over the whole process lifetime.
"""
import json, re, subprocess, sys, time


def snapshot():
    """pid -> (rss_kb, cputime_seconds, command)"""
    out = subprocess.run(
        ["ps", "-axo", "pid=,rss=,time=,command="],
        capture_output=True, text=True,
    ).stdout
    procs = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)", line)
        if not m:
            continue
        pid, rss, t, cmd = m.groups()
        parts = [float(x) for x in t.split(":")]
        secs = 0.0
        for p in parts:
            secs = secs * 60 + p
        procs[int(pid)] = (int(rss), secs, cmd)
    return procs


def cpu_seconds(procs, pids):
    return sum(procs[p][1] for p in pids if p in procs)


def rss_mb(procs, pids):
    return sum(procs[p][0] for p in pids if p in procs) / 1024.0


WINDOW_QUERY = (
    'tell application "System Events" to '
    'count windows of (first process whose name is "%s")'
)


def window_count(proc_name):
    r = subprocess.run(
        ["osascript", "-e", WINDOW_QUERY % proc_name],
        capture_output=True, text=True,
    )
    try:
        return int(r.stdout.strip())
    except ValueError:
        return 0


def run(label, launch, match, proc_name=None, settle_cores=0.05, settle_hits=4,
        idle_secs=30, timeout=45):
    before = set(snapshot())
    pat = re.compile(match, re.I)

    t0 = time.time()
    subprocess.run(launch, shell=True)

    mine, t_first, t_settle, t_window = set(), None, None, None
    quiet = 0
    prev_t, prev_cpu = t0, 0.0

    while time.time() - t0 < timeout:
        time.sleep(0.15)
        if t_window is None and proc_name and window_count(proc_name) > 0:
            t_window = time.time() - t0
        procs = snapshot()
        for pid, (_, _, cmd) in procs.items():
            if pid not in before and pat.search(cmd):
                if pid not in mine:
                    mine.add(pid)
                    if t_first is None:
                        t_first = time.time() - t0
        if not mine:
            continue
        now, cpu = time.time(), cpu_seconds(procs, mine)
        rate = (cpu - prev_cpu) / max(now - prev_t, 1e-6)
        prev_t, prev_cpu = now, cpu
        # "ready" only counts once a window is up: Electron puts an empty
        # window on screen early and fills it afterwards, so a quiet moment
        # before that is disk wait, not readiness
        if t_settle is None and t_window is not None and now - t0 > t_window:
            quiet = quiet + 1 if rate < settle_cores else 0
            if quiet >= settle_hits:
                # settle began when the quiet run started
                t_settle = (now - t0) - settle_hits * 0.15

    procs = snapshot()
    mine = {p for p in mine if p in procs}
    result = {
        "app": label,
        "first_process_s": round(t_first, 2) if t_first else None,
        "first_window_s": round(t_window, 2) if t_window else None,
        "settled_s": round(t_settle, 2) if t_settle else None,
        "processes": len(mine),
        "rss_mb": round(rss_mb(procs, mine)),
    }

    if idle_secs:
        c0, w0 = cpu_seconds(procs, mine), time.time()
        time.sleep(idle_secs)
        procs = snapshot()
        c1, w1 = cpu_seconds(procs, mine), time.time()
        result["idle_cpu_pct_of_core"] = round((c1 - c0) / (w1 - w0) * 100, 2)
        result["rss_mb_after_idle"] = round(rss_mb(procs, mine))

    result["pids"] = sorted(mine)
    return result


if __name__ == "__main__":
    cfg = json.loads(sys.argv[1])
    print(json.dumps(run(**cfg)))

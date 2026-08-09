#!/usr/bin/env python3
"""Steady-state memory with N projects open, sampled repeatedly.

A single reading of zero is misleading: most of its memory is WebKit's GPU
process, which grows and is reclaimed on its own schedule, so successive
samples can differ by hundreds of megabytes. This takes several and reports
the range.
"""
import re, statistics, subprocess, sys, time

PROJECTS = sys.argv[1:] or [
    "/Users/vidtopolovec/Projects/zero",
    "/Users/vidtopolovec/Projects/metamorfoza",
    "/Users/vidtopolovec/Projects/hyperbot",
    "/Users/vidtopolovec/Projects/racunko",
]
SAMPLES, GAP = 5, 15

APPS = [
    ("Cursor", lambda p: f'open -a Cursor "{p}"', r"Cursor\.app", "Cursor"),
    ("zero", lambda p: f'"$HOME/.local/bin/zero" "{p}"',
     r"zero\.app|WebKit\.(GPU|Networking|WebContent)|audio\.SandboxHelper", "zero"),
]


def pids():
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    return {int(m.group(1)): m.group(2)
            for m in (re.match(r"\s*(\d+)\s+(.*)", l) for l in out.splitlines()) if m}


def footprint_mb(pid):
    out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True).stdout
    m = re.search(r"phys_footprint.*?([\d.]+)\s*([KMG])B", out, re.S | re.I)
    if not m:
        return 0.0
    n, u = float(m.group(1)), m.group(2).upper()
    return n / 1024 if u == "K" else n * 1024 if u == "G" else n


def measure(before, pattern):
    pat, mb, n = re.compile(pattern, re.I), 0.0, 0
    for pid, cmd in pids().items():
        if pid not in before and pat.search(cmd):
            mb += footprint_mb(pid)
            n += 1
    return round(mb), n


def ensure_quit(name):
    subprocess.run(f"osascript -e 'quit app \"{name}\"'", shell=True, capture_output=True)
    for _ in range(10):
        if subprocess.run(["pgrep", "-x", name], capture_output=True).returncode != 0:
            return
        time.sleep(1)
    subprocess.run(["pkill", "-x", name], capture_output=True)
    time.sleep(3)


for label, opener, pattern, quitname in APPS:
    ensure_quit(quitname)
    before = set(pids())
    for p in PROJECTS:
        subprocess.run(opener(p), shell=True)
        time.sleep(12)
    time.sleep(20)
    readings, procs = [], 0
    for _ in range(SAMPLES):
        mb, procs = measure(before, pattern)
        readings.append(mb)
        time.sleep(GAP)
    print(f"{label}: {len(PROJECTS)} projects, {procs} processes — "
          f"min {min(readings)} / median {round(statistics.median(readings))} / "
          f"max {max(readings)} MB   samples={readings}", flush=True)
    ensure_quit(quitname)

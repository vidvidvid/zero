#!/usr/bin/env python3
"""Run each editor N times on the same project, report the median."""
import json, statistics, subprocess, sys, time
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from bench import run

PROJECT = sys.argv[1] if len(sys.argv) > 1 else str(__import__("pathlib").Path(__file__).parent.parent)
REPS = 3

APPS = [
    {
        "label": "Cursor",
        "launch": f'open -a Cursor "{PROJECT}"',
        "match": r"Cursor\.app",
        "proc_name": "Cursor",
        "quit": 'osascript -e \'quit app "Cursor"\'',
    },
    {
        "label": "zero",
        "launch": f'"$HOME/.local/bin/zero" "{PROJECT}"',
        # WebKit runs the page in out-of-process XPC services that live in
        # /System, not in the bundle — they are zero's cost all the same
        "match": r"zero\.app|WebKit\.(GPU|Networking|WebContent)|audio\.SandboxHelper",
        "proc_name": "zero",
        "quit": 'osascript -e \'quit app "zero"\'',
    },
]

out = {}
for app in APPS:
    runs = []
    for i in range(REPS):
        last = i == REPS - 1
        r = run(
            label=app["label"], launch=app["launch"], match=app["match"],
            proc_name=app["proc_name"], settle_cores=0.10,
            idle_secs=30 if last else 0, timeout=45,
        )
        runs.append(r)
        print(f"  {app['label']} run {i+1}: {json.dumps({k: v for k, v in r.items() if k != 'pids'})}", flush=True)
        subprocess.run(app["quit"], shell=True, capture_output=True)
        time.sleep(4)

    def med(key):
        vals = [r[key] for r in runs if r.get(key) is not None]
        return round(statistics.median(vals), 2) if vals else None

    out[app["label"]] = {
        "first_window_s": med("first_window_s"),
        "settled_s": med("settled_s"),
        "processes": med("processes"),
        "rss_mb": med("rss_mb"),
        "idle_cpu_pct_of_core": runs[-1].get("idle_cpu_pct_of_core"),
        "rss_mb_after_idle": runs[-1].get("rss_mb_after_idle"),
        "runs": [{k: v for k, v in r.items() if k != "pids"} for r in runs],
    }

print(json.dumps(out, indent=2))

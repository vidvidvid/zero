#!/usr/bin/env python3
"""How memory scales as you open more projects.

The interesting question for zero specifically: it keeps every project laid
out and painted so switching is a compositor swap, which trades memory for
switch latency. Cursor opens a window per folder. This measures what that
trade actually costs, project by project.

Usage: python3 bench/multi.py [project ...]
"""
import re, subprocess, sys, time

DEFAULT = [
    "/Users/vidtopolovec/Projects/zero",
    "/Users/vidtopolovec/Projects/metamorfoza",
    "/Users/vidtopolovec/Projects/hyperbot",
    "/Users/vidtopolovec/Projects/racunko",
]
PROJECTS = sys.argv[1:] or DEFAULT

APPS = [
    {
        "label": "Cursor",
        "open": lambda p: f'open -a Cursor "{p}"',
        "match": r"Cursor\.app",
        "quit": "Cursor",
    },
    {
        "label": "zero",
        "open": lambda p: f'"$HOME/.local/bin/zero" "{p}"',
        "match": r"zero\.app|WebKit\.(GPU|Networking|WebContent)|audio\.SandboxHelper",
        "quit": "zero",
    },
]

SETTLE_FIRST, SETTLE_NEXT = 30, 22


def pids():
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    d = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(.*)", line)
        if m:
            d[int(m.group(1))] = m.group(2)
    return d


def footprint_mb(pid):
    out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True).stdout
    m = re.search(r"phys_footprint.*?([\d.]+)\s*([KMG])B", out, re.S | re.I)
    if not m:
        return 0.0
    n, unit = float(m.group(1)), m.group(2).upper()
    return n / 1024 if unit == "K" else n * 1024 if unit == "G" else n


def total(before, pattern):
    pat = re.compile(pattern, re.I)
    mb, n = 0.0, 0
    for pid, cmd in pids().items():
        if pid in before or not pat.search(cmd):
            continue
        mb += footprint_mb(pid)
        n += 1
    return round(mb), n


def ensure_quit(name):
    """A still-running app would have all of its processes in the baseline,
    and reopening a folder it already has open adds none — which reads as
    zero memory rather than as the mistake it is."""
    subprocess.run(f"osascript -e 'quit app \"{name}\"'", shell=True, capture_output=True)
    for _ in range(10):
        if subprocess.run(["pgrep", "-x", name], capture_output=True).returncode != 0:
            return
        time.sleep(1)
    subprocess.run(["pkill", "-x", name], capture_output=True)
    time.sleep(3)


for app in APPS:
    ensure_quit(app["quit"])
    before = set(pids())
    print(f"--- {app['label']} ---", flush=True)
    prev = 0
    for i, project in enumerate(PROJECTS):
        subprocess.run(app["open"](project), shell=True)
        time.sleep(SETTLE_FIRST if i == 0 else SETTLE_NEXT)
        mb, n = total(before, app["match"])
        print(f"  {i+1} project(s)  {mb:>5} MB  ({n} processes)  "
              f"+{mb - prev:>4} MB   after opening {project.split('/')[-1]}", flush=True)
        prev = mb
    subprocess.run(f'osascript -e \'quit app "{app["quit"]}"\'', shell=True, capture_output=True)
    time.sleep(8)

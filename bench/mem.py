#!/usr/bin/env python3
"""Memory by macOS's own accounting.

Summed RSS counts a shared framework page once per process, which penalises
whichever app has more processes. `footprint` reports phys_footprint — the
number Activity Monitor shows under "Memory" — which is the honest one.
"""
import re, subprocess, sys, time

PROJECT = sys.argv[1] if len(sys.argv) > 1 else str(__import__("pathlib").Path(__file__).parent.parent)
APPS = [
    ("Cursor", f'open -a Cursor "{PROJECT}"', r"Cursor\.app", "Cursor"),
    ("zero", f'"$HOME/.local/bin/zero" "{PROJECT}"',
     r"zero\.app|WebKit\.(GPU|Networking|WebContent)|audio\.SandboxHelper", "zero"),
]


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
        return None
    n, unit = float(m.group(1)), m.group(2).upper()
    return n / 1024 if unit == "K" else n * 1024 if unit == "G" else n


for label, launch, pattern, quitname in APPS:
    before = set(pids())
    subprocess.run(launch, shell=True)
    time.sleep(30)
    now, total, rows = pids(), 0.0, []
    pat = re.compile(pattern, re.I)
    for pid, cmd in now.items():
        if pid in before or not pat.search(cmd):
            continue
        mb = footprint_mb(pid)
        if mb is None:
            continue
        total += mb
        rows.append((pid, round(mb), cmd.split("/")[-1][:50]))
    print(f"--- {label} ---")
    for r in sorted(rows, key=lambda r: -r[1]):
        print(f"  {r[0]:>7}  {r[1]:>6} MB  {r[2]}")
    print(f"  {label} TOTAL phys_footprint: {round(total)} MB  ({len(rows)} processes)")
    subprocess.run(f'osascript -e \'quit app "{quitname}"\'', shell=True, capture_output=True)
    time.sleep(6)

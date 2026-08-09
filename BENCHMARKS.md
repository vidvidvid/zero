# Benchmarks

zero against Cursor, both opening the same project on the same machine, in the
same session. Everything here is reproducible with the scripts in
[`bench/`](bench/) — run them yourself rather than taking these numbers on
trust.

Read the [caveats](#what-this-is-not) before quoting any of it. Cursor does
enormously more than zero does, and most of the gap below is that difference
showing up as a cost, not Cursor being badly built.

```
Machine   Apple M3 Max · 36 GB · macOS 26.5.1
Cursor    3.15.6, with the extensions I actually have installed
zero      0.1.0
Project   the zero repo itself — ~5k lines, a git worktree, node_modules present
Method    3 launches each, median reported, apps quit between runs
```

## Disk

| | zero | Cursor | |
|---|---:|---:|---|
| App bundle | **11 MB** | 860 MB | 78× |
| Installer | **3.6 MB** dmg | — | |
| Files in the bundle | **3** | 17,035 | |
| Shipped JS | **1.3 MB** | 12 MB across 12,025 files | 9× |
| Electron/WebKit runtime | 0 (system WebKit) | 259 MB bundled | |
| Bundled extensions | 0 | 116 | |

zero's bundle is three files because Tauri compiles the frontend into the
binary and uses the WebKit that ships with macOS. Electron carries its own
Chromium.

## Launch

Time from `open` to the app's first window on screen, via the Accessibility
API, then to *ready* — the first moment after the window appears when CPU drops
below 10% of a core and stays there. The second number matters because
Electron puts an empty window up early and fills it afterwards; measuring only
"a window exists" would flatter it.

| | zero | Cursor |
|---|---:|---:|
| Window on screen | **0.40 s** | 1.14 s |
| Ready to use | **2.39 s** | 6.59 s |
| First launch of the session (cold) | **0.38 s** | 8.16 s |

The cold number is the honest one for how it feels in practice: the first time
you open an editor after booting, Cursor took **8.2 seconds** and zero took
**0.4**. zero has essentially no cold penalty because there is almost nothing
to page in.

## Memory

Two accountings, because they disagree and only one of them is fair.

| | zero | Cursor | |
|---|---:|---:|---|
| **phys_footprint** (Activity Monitor's "Memory") | **354 MB** | 687 MB | 1.9× |
| Summed RSS across processes | 256 MB | 1,140–2,186 MB | |
| Processes | **5** | 8–12 | |

**Use the first row.** Summed RSS counts a shared framework page once per
process, so it punishes Cursor for having twelve of them and produces a
headline like "8× less memory" that isn't true. By macOS's own accounting the
real answer is that zero uses **a bit under half**. That's a good result, not a
spectacular one, and the spectacular version would have been wrong.

Worth noting for anyone reading zero's code: its single largest consumer isn't
the app at all, it's `WebKit.GPU` at 216 MB — more than half the total, and
more than seven times the 29 MB the zero process itself uses.

## Idle CPU

CPU time consumed over 30 seconds of sitting there untouched, as a percentage
of one core.

| | zero | Cursor |
|---|---:|---:|
| Idle | **1.10%** | 2.66% |

Both are low. Cursor's is file watchers, the extension host, and a git worker;
zero's is its own once-a-second poll for what Claude is doing in each terminal.

## Code

| | zero | Cursor |
|---|---:|---|
| Source | **4,988 lines** (2,649 TS/TSX · 913 Rust · 1,426 CSS) | closed, VS Code fork |
| npm dependencies | **21** (51 packages installed) | — |
| Rust crates | 490 | — |

## What this is not

The comparison is only honest with all of this attached:

- **Cursor does vastly more.** Language servers, autocomplete, an extension
  ecosystem, debugging, remote development, notebooks, settings sync,
  multi-platform, and an actual AI product. zero has none of that. It opens
  files, runs terminals, and shows you git worktrees. **Most of the gap above
  is that difference, priced in bytes and milliseconds.** A fair one-line
  summary is "doing less costs less", not "zero is better engineered".
- **zero's numbers include a live shell.** It always has a terminal open;
  Cursor opens none by default. That handicap is real and I've left it in.
- **Cursor was measured with my extensions installed**, which is how I actually
  ran it — not a clean profile. A stock install would use less.
- **Neither had an agent running.** Put Claude Code in both and that process
  dwarfs the editor either way.
- **Nothing here measures the things you feel most**: typing latency, scroll
  smoothness, search speed on a big repo, or how either behaves on a 50 MB
  file. Those need instrumentation I don't have, and I'd rather report nothing
  than guess.
- **Single machine, single session, n=3.** Launch timings in particular move
  with disk cache state.

The one performance claim zero makes that isn't in this table is frame rate,
and it's not a comparison with Cursor — it's a fix for a WebKit default that
would otherwise cap the app at 60 fps. That's documented in the
[README](README.md#120-fps-in-a-webview).

## Reproducing

```sh
python3 bench/drive.py [project-path]   # launch, memory, idle CPU, 3 reps
python3 bench/mem.py   [project-path]   # phys_footprint per process
```

Both diff the process table around launch, so an app's helpers are attributed
to it whether they live inside the bundle (Electron) or in `/System` (WebKit's
XPC services). Anything already running is excluded. CPU is measured as the
delta of cumulative CPU time over a wall interval — `ps %CPU` reports an
average over the process's whole lifetime and is useless for this.

`drive.py` needs Accessibility permission for the terminal it runs in, to count
windows.

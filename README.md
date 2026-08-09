# zero

A minimal macOS code editor built around running coding agents.

Five thousand lines, an 11 MB app. It exists because Cursor was a 350 MB
window around a terminal running Claude Code, and almost none of the rest of it
was getting used. So this is the rest of it, removed: projects as tabs, a
terminal that takes the full width, git worktrees down the side, and an editor
for when you actually need to read a file.

Never capitalised. It's `zero`, not Zero.

```
 4,970 lines of source   (3,556 code, 1,414 CSS)
    11 MB app bundle
   3.6 MB dmg
```

## What's in it

**Projects are tabs.** Each one keeps its own terminals, sidebar and open files,
and switching between them is a compositor swap — every project stays laid out
and painted, so nothing re-fits or re-rasterises when you come back to it.

**A ring per tab tells you what Claude is doing.** A sweeping arc while a
session is working, a closed green circle once it has gone quiet and is waiting
on you. Only on the tabs you aren't looking at, and it clears when you've been
there. It works by walking each shell's process tree once a second looking for
a live `claude`, then reading how long that pty has been silent — no
integration, no cooperation from the agent.

**The terminal is the point.** Full window width, splits in any direction with
draggable dividers, and no chrome: no title, no bar, no rule. The split and
close buttons appear only when the pointer is in the top fifth of a pane.

**Git worktrees, not branches.** The sidebar lists every worktree with its
changes, staging, and commit box — which is the shape of the work when several
agents are going at once.

Plus the ordinary things: file tree, ripgrep-backed search, diffs, tab
reordering by drag, `⌘`/`⌘-` zoom.

### Keys

| | |
|---|---|
| `⌘T` / `⌃⇧\`` | new terminal |
| `⌘\` / `⌘⇧\` | split terminal right / down |
| `⌘J` / `⌃\`` | show or hide the terminal |
| `⌘B` | sidebar |
| `⌘⇧E` / `⌘⇧F` / `⌃⇧G` | files / search / worktrees |
| `⌘N` / `⌘W` | new file / close file |
| `⌘\`` | cycle projects |
| `⌘⇧O` | open a project |

## Install

Requires macOS on Apple Silicon. `git` for the worktree panel, `ripgrep` for
search — both optional in the sense that the rest still works without them.

```sh
npm install
npm run tauri build
cp -R src-tauri/target/release/bundle/macos/zero.app /Applications/
```

The app is **not signed or notarised**, so the first launch needs a
right-click → Open (or `xattr -dr com.apple.quarantine /Applications/zero.app`).
Signing it properly needs an Apple Developer account.

### The `zero` command

zero installs a `zero` command into `~/.local/bin` every time it launches, so
putting the app in `/Applications` is the whole installation.

```sh
zero          # launch or focus
zero .        # open this directory as a project
```

It hands the directory over through a file the app watches rather than through
arguments: `open -a` doesn't pass argv to a running app, and launching the
binary directly would start a second instance with its own set of shells.

## Things it does to your machine

Two of these are the kind of thing you'd want told to you plainly rather than
discovered:

- **It writes `~/.local/bin/zero`** on every launch (overwriting it, if you've
  edited it). Delete `cli.rs`'s `install_command` call in `lib.rs` if you'd
  rather it didn't.
- **It points `ZDOTDIR` at its own directory** for the shells it spawns, so it
  can shorten the prompt from `user@host dir %` to `dir %`. Its startup files
  source yours first and hand `ZDOTDIR` straight back, and the prompt is
  replaced *only* if it's still macOS's stock one — set `PROMPT` yourself and
  zero won't touch it. Same technique VS Code and Warp use.

Nothing is sent anywhere. There is no network code in this app.

## 120 fps in a WebView

The most interesting thing in here is 60 lines of Objective-C messaging in
[`src-tauri/src/high_refresh.rs`](src-tauri/src/high_refresh.rs).

**WKWebView clamps rendering to 60 fps**, even on a 120 Hz ProMotion display.
You will find it widely claimed that macOS 26 removed this. That claim is
false — measured on 26.5.1, a Tauri window renders at 59 fps while Safari on
the same machine, on the same page, does 125.

Safari isn't special. It just turns the clamp off, through a WebKit feature
flag named `PreferPageRenderingUpdatesNear60FPSEnabled`. The flag is reachable
from the app side, but only through private API: `+[WKPreferences _features]`
returns every feature object WebKit knows about, and
`-[WKPreferences _setEnabled:forFeature:]` toggles one. So zero walks the
feature list at startup, finds that key, and switches it off.

```
before   59 fps   median frame 16.7 ms
after   125 fps   median frame  8.0 ms   (p90 9.0 ms over 376 scroll frames)
```

Everything is guarded — `respondsToSelector` on both selectors, and the whole
thing degrades to a printed line and a 60 fps app if a future WebKit drops
either. The cost is that **this rules out the Mac App Store forever**, which is
why it's opt-out-able by deleting one call in `lib.rs`.

## Smooth scrolling a terminal

The other piece worth reading is
[`src/lib/smoothTermScroll.ts`](src/lib/smoothTermScroll.ts).

xterm.js quantises scrolling to whole rows: its viewport rounds `scrollTop` to
a row index and only emits a scroll when that index changes. This happens
*above* the renderer, so switching to canvas or WebGL doesn't help — DOM,
canvas and WebGL all step identically. Terminal scrolling feels worse than a
web page because it genuinely is.

zero takes the wheel events itself, hands xterm the whole rows, and applies the
sub-row remainder as a GPU transform on `.xterm-screen`. Text selection stays
aligned for free, because xterm derives mouse coordinates from
`getBoundingClientRect`, which already includes the transform. The transform is
never cleared to `""` — always `translate3d(0, 0, 0)` — since dropping it
destroys the composited layer and the next gesture pays 150 ms to rasterise a
new one.

## Built with

[Tauri 2](https://tauri.app) · [React 19](https://react.dev) ·
[CodeMirror 6](https://codemirror.net) · [xterm.js 6](https://xtermjs.org) ·
[portable-pty](https://github.com/wez/wezterm/tree/main/pty)

The DOM renderer is used for the terminal on purpose: WebGL contexts get
dropped by WKWebView, which shows up as frozen panes and webview crashes, and
the only published canvas addon is compiled against xterm 5 internals and
renders nothing on 6.

## License

MIT. See [LICENSE](LICENSE).

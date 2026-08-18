use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    // false once pty_kill ran: suppresses the reader thread's pty-exit so a
    // deliberate kill can't be mistaken for the shell exiting on its own
    alive: Arc<AtomicBool>,
    cwd: String,
    shell_pid: Option<u32>,
    // ms since the epoch of the last byte this shell printed that wasn't a
    // reaction to typing, and of the last keystroke sent to it
    last_output: Arc<AtomicU64>,
    last_input: Arc<AtomicU64>,
    // when the current run of output began; a run ends after BURST_GAP_MS of
    // silence. Lets a one-off redraw be told apart from sustained work.
    burst_start: Arc<AtomicU64>,
    // what the terminal title last said about Claude: TITLE_* below
    claude_title: Arc<AtomicU8>,
}

/// No title seen yet, or the last one wasn't Claude's — fall back to guessing
/// from output activity.
const TITLE_UNKNOWN: u8 = 0;
/// Claude's title starts with a spinner glyph: mid-task.
const TITLE_WORKING: u8 = 1;
/// Claude's title starts with ✳: waiting on you — finished, or sitting on a
/// permission prompt.
const TITLE_IDLE: u8 = 2;

/// Reads Claude Code's state out of the terminal titles it sets, which beats
/// inferring it from output timing: Claude retitles the terminal through
/// OSC 0 the moment it starts and the moment it stops, while its drawn UI can
/// go quiet mid-task (a silent tool call, a slow API turn) and flicker the
/// activity heuristic.
///
/// Measured against Claude Code 2.1.234: `ESC ] 0 ; <glyph> <topic> BEL`,
/// where the glyph is ✳ when idle and an animated ◐/◑ while working —
/// retitled to ✳ during a permission prompt too, which is right, since that
/// *is* waiting on you. Any other title (the shell's own, say) means Claude
/// isn't speaking, and the caller falls back to the timing heuristic.
struct TitleScanner {
    state: TitleScan,
    buf: Vec<u8>,
}

enum TitleScan {
    Ground,
    Esc,
    Osc,
    /// ESC seen inside the OSC — either the start of the ST terminator or a
    /// mangled sequence.
    OscEsc,
}

/// Longest title worth keeping. Anything bigger isn't a title, so the
/// sequence is abandoned rather than buffered without bound.
const TITLE_MAX: usize = 512;

impl TitleScanner {
    fn new() -> Self {
        Self { state: TitleScan::Ground, buf: Vec::new() }
    }

    /// Feed one chunk of pty output; sequences may split anywhere across
    /// chunks. Returns the classification of the last complete title, if any.
    fn feed(&mut self, bytes: &[u8]) -> Option<u8> {
        let mut latest = None;
        for &b in bytes {
            if let Some(t) = self.step(b) {
                latest = Some(t);
            }
        }
        latest
    }

    fn step(&mut self, b: u8) -> Option<u8> {
        match self.state {
            TitleScan::Ground => {
                if b == 0x1b {
                    self.state = TitleScan::Esc;
                }
                None
            }
            TitleScan::Esc => {
                self.state = match b {
                    b']' => {
                        self.buf.clear();
                        TitleScan::Osc
                    }
                    0x1b => TitleScan::Esc,
                    _ => TitleScan::Ground,
                };
                None
            }
            TitleScan::Osc => match b {
                0x07 => {
                    self.state = TitleScan::Ground;
                    self.classify()
                }
                0x1b => {
                    self.state = TitleScan::OscEsc;
                    None
                }
                _ if self.buf.len() >= TITLE_MAX => {
                    self.state = TitleScan::Ground;
                    None
                }
                _ => {
                    self.buf.push(b);
                    None
                }
            },
            TitleScan::OscEsc => {
                if b == b'\\' {
                    self.state = TitleScan::Ground;
                    self.classify()
                } else {
                    // not ST — abandon the sequence, but the ESC may open a
                    // new one, so replay this byte through the Esc state
                    self.state = TitleScan::Esc;
                    self.step(b)
                }
            }
        }
    }

    /// None for an OSC that isn't a title at all (hyperlinks, colors) — those
    /// say nothing about Claude. A real title that isn't Claude's is
    /// Some(TITLE_UNKNOWN): the shell has retitled, Claude no longer speaks.
    fn classify(&self) -> Option<u8> {
        // OSC 0 sets icon and title, 1 and 2 each half; Claude uses 0 today
        let title = [b"0;".as_slice(), b"1;", b"2;"]
            .iter()
            .find_map(|p| self.buf.strip_prefix(*p))?;
        Some(match String::from_utf8_lossy(title).chars().next() {
            Some('✳') => TITLE_IDLE,
            // the full half-circle family, though only ◐ and ◑ were observed
            Some('◐'..='◓') => TITLE_WORKING,
            _ => TITLE_UNKNOWN,
        })
    }
}

/// Output arriving within this long after a keystroke is echo / input-box
/// redraw, not Claude doing work.
const ECHO_WINDOW_MS: u64 = 350;

/// Silence longer than this starts a new run of output.
const BURST_GAP_MS: u64 = 400;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
pub struct PtyManager(Mutex<HashMap<String, PtySession>>);

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
}

/// zsh has no way to set the prompt from the environment: macOS's `/etc/zshrc`
/// assigns the stock `%n@%m %1~ %#` and only files zsh loads afterwards can
/// change it. The way round that — the same one VS Code and Warp use — is to
/// point ZDOTDIR at a directory of our own whose startup files source the
/// user's, then add ours at the end.
///
/// Every file is guarded, so a missing or broken user config still yields a
/// working shell, and the prompt is only replaced when it is still the stock
/// one: the moment you set PROMPT yourself, zero stops touching it.
///
/// Returns the directory to hand to zsh as ZDOTDIR, or None if anything about
/// writing it fails — in which case the shell simply starts as it always did.
fn zsh_dotdir(home: &str) -> Option<String> {
    // sourced with ZDOTDIR pointing at the user's directory, then put back, so
    // zsh keeps reading the rest of its startup files from ours
    const RELAY: &str = r#"# Written by zero. Loads your own zsh config, unchanged.
zero_here=$ZDOTDIR
ZDOTDIR=${ZERO_ZDOTDIR:-$HOME}
[[ -f "$ZDOTDIR/FILE" ]] && source "$ZDOTDIR/FILE"
ZDOTDIR=$zero_here
unset zero_here
"#;

    let dir = std::path::Path::new(home)
        .join("Library/Application Support/zero/zsh");
    std::fs::create_dir_all(&dir).ok()?;

    for name in [".zshenv", ".zprofile"] {
        std::fs::write(dir.join(name), RELAY.replace("FILE", name)).ok()?;
    }
    // last of ours to run: hand ZDOTDIR back for good, so anything later (and
    // any zsh started from this one) reads the user's files directly
    let zshrc = format!(
        "{}\n\
         # only the directory — user@host is the same in every pane and says\n\
         # nothing you don't already know. Skipped if you set your own prompt.\n\
         [[ \"$PROMPT\" == '%n@%m %1~ %# ' ]] && PROMPT='%1~ %# '\n\
         ZDOTDIR=${{ZERO_ZDOTDIR:-$HOME}}\n",
        RELAY.replace("FILE", ".zshrc")
    );
    std::fs::write(dir.join(".zshrc"), zshrc).ok()?;

    Some(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<PtyManager>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // This shell belongs to zero, not to whatever launched zero. Started from a
    // terminal, the parent's own identity comes along with it — and on macOS
    // that means TERM_SESSION_ID, which switches on /etc/zshrc_Apple_Terminal:
    // every new pty then opens with "Restored session: <date>" and starts
    // saving history into ~/.zsh_sessions for a window that has nothing to do
    // with us. Naming ourselves is also the hook a shell config needs to tell
    // it's running in here, the same way VS Code sets TERM_PROGRAM=vscode.
    cmd.env("TERM_PROGRAM", "zero");
    cmd.env_remove("TERM_SESSION_ID");
    cmd.env("SHELL_SESSIONS_DISABLE", "1");
    // Spotlight/Dock-launched apps get launchd's minimal environment, not the
    // user's shell env — ensure the usual tool locations are on PATH.
    let mut path = std::env::var("PATH").unwrap_or_default();
    if path.is_empty() {
        path = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string();
    }
    for p in ["/usr/local/bin", "/opt/homebrew/sbin", "/opt/homebrew/bin"] {
        if !path.split(':').any(|seg| seg == p) {
            path = format!("{p}:{path}");
        }
    }
    cmd.env("PATH", path);

    // zsh only: bash and fish read none of these files
    if shell.rsplit('/').next() == Some("zsh") {
        if let Ok(home) = std::env::var("HOME") {
            if let Some(dir) = zsh_dotdir(&home) {
                // where the user's own config lives, for our files to source
                cmd.env("ZERO_ZDOTDIR", std::env::var("ZDOTDIR").unwrap_or(home));
                cmd.env("ZDOTDIR", dir);
            }
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let shell_pid = child.process_id();

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let alive = Arc::new(AtomicBool::new(true));
    let last_output = Arc::new(AtomicU64::new(now_ms()));
    let last_input = Arc::new(AtomicU64::new(0));
    let burst_start = Arc::new(AtomicU64::new(now_ms()));
    let claude_title = Arc::new(AtomicU8::new(TITLE_UNKNOWN));
    let reader_last = last_output.clone();
    let reader_input = last_input.clone();
    let reader_burst = burst_start.clone();
    let reader_title = claude_title.clone();
    let reader_alive = alive.clone();
    let reader_id = id.clone();
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut titles = TitleScanner::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !reader_alive.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Some(t) = titles.feed(&buf[..n]) {
                        reader_title.store(t, Ordering::Relaxed);
                    }
                    // echo of what you just typed isn't Claude working
                    let t = now_ms();
                    if t.saturating_sub(reader_input.load(Ordering::Relaxed)) > ECHO_WINDOW_MS {
                        let prev = reader_last.swap(t, Ordering::Relaxed);
                        if t.saturating_sub(prev) > BURST_GAP_MS {
                            reader_burst.store(t, Ordering::Relaxed);
                        }
                    }
                    let _ = reader_app.emit(
                        "pty-output",
                        PtyOutput {
                            id: reader_id.clone(),
                            bytes: buf[..n].to_vec(),
                        },
                    );
                }
            }
        }
        if reader_alive.load(Ordering::Relaxed) {
            let _ = reader_app.emit("pty-exit", PtyExit { id: reader_id });
        }
    });

    state.0.lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            child,
            alive,
            cwd,
            shell_pid,
            last_output,
            last_input,
            burst_start,
            claude_title,
        },
    );
    Ok(())
}

#[derive(Serialize)]
pub struct ClaudeStat {
    pub cwd: String,
    /// a `claude` process is running under this shell
    pub running: bool,
    /// ms since that shell last printed anything — Claude Code animates while
    /// it works, so silence means it's finished and waiting on you
    pub quiet_ms: u64,
    /// how long the current unbroken run of output has lasted. A redraw
    /// triggered by focus or resize is a blip; real work sustains.
    pub burst_ms: u64,
    /// what Claude's own terminal title says — Some(true) mid-task,
    /// Some(false) waiting on you, None when no Claude title has been seen
    /// and the caller has only quiet_ms/burst_ms to go on
    pub title_working: Option<bool>,
}

/// One `ps` sweep, then walk each shell's descendants looking for `claude`
/// (the CLI sets its own process name, so comm matches exactly).
///
/// Async because this polls once a second: as a sync command Tauri would run
/// the `ps` sweep on the main thread, and every sweep was a hitch in whatever
/// the window was doing — a tab drag twitching once a second, for instance.
/// The sweep itself goes through the blocking pool for the same reason every
/// body in git.rs does — a parked tokio worker is a parked command slot.
#[tauri::command]
pub async fn claude_status(state: tauri::State<'_, PtyManager>) -> Result<Vec<ClaudeStat>, ()> {
    let children = crate::git::blocking(|| {
        let out = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,comm="])
            .output();
        let mut children: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
        if let Ok(out) = out {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                // ps pads its columns ("  1609  1257 claude"), so split on
                // runs of whitespace — splitn on single chars yields empty
                // fields here
                let mut it = line.split_whitespace();
                let (Some(pid), Some(ppid), Some(comm)) = (it.next(), it.next(), it.next())
                else {
                    continue;
                };
                if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                    let name = comm.rsplit('/').next().unwrap_or("").to_string();
                    children.entry(ppid).or_default().push((pid, name));
                }
            }
        }
        children
    })
    .await;

    fn has_claude(children: &HashMap<u32, Vec<(u32, String)>>, pid: u32, depth: u8) -> bool {
        if depth > 6 {
            return false;
        }
        children.get(&pid).is_some_and(|kids| {
            kids.iter()
                .any(|(cpid, name)| name.starts_with("claude") || has_claude(children, *cpid, depth + 1))
        })
    }

    let now = now_ms();
    let stats = state
        .0
        .lock()
        .unwrap()
        .values()
        .map(|s| {
            let last = s.last_output.load(Ordering::Relaxed);
            let running = s.shell_pid.is_some_and(|p| has_claude(&children, p, 0));
            if !running {
                // don't let a dead session's last title speak for the next
                // one: a claude that exits mid-work leaves ◐ behind, and a
                // later launch would wear it until its own first retitle
                s.claude_title.store(TITLE_UNKNOWN, Ordering::Relaxed);
            }
            ClaudeStat {
                cwd: s.cwd.clone(),
                running,
                quiet_ms: now.saturating_sub(last),
                burst_ms: last.saturating_sub(s.burst_start.load(Ordering::Relaxed)),
                title_working: match s.claude_title.load(Ordering::Relaxed) {
                    TITLE_WORKING => Some(true),
                    TITLE_IDLE => Some(false),
                    _ => None,
                },
            }
        })
        .collect();
    Ok(stats)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("no such pty")?;
    session.last_input.store(now_ms(), Ordering::Relaxed);
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let session = map.get(&id).ok_or("no such pty")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Signal a shell and then collect it.
///
/// Until someone calls `wait`, the kernel keeps a dead child in the process
/// table so its exit status can still be read — a zombie — and
/// `std::process::Child` has no `Drop` that does it for you.
///
/// portable_pty's `kill` half-handles this, which is what made the leak so
/// quiet. It sends SIGHUP, then spends about 200 ms calling `try_wait`; a shell
/// that dies in that window *is* collected and leaves nothing behind. Only the
/// ones still alive at the end of the grace period get SIGKILLed — and those it
/// abandons. So an idle pane closed cleanly and a pane running an agent left a
/// zombie, which is why they accumulated slowly rather than one per close.
///
/// On its own thread because `wait` blocks and a synchronous Tauri command runs
/// on the main thread: waiting there would hang the window for as long as the
/// shell took to die. A thread that outlives its usefulness is the cheaper
/// failure of the two.
fn reap(mut child: Box<dyn Child + Send + Sync>) {
    std::thread::spawn(move || {
        let _ = child.kill();
        let _ = child.wait();
    });
}

/// Kill every session — called on frontend boot so a webview reload
/// (e.g. after a content-process crash) can't leak orphaned shells.
#[tauri::command]
pub fn pty_kill_all(state: tauri::State<PtyManager>) -> Result<(), String> {
    for (_, session) in state.0.lock().unwrap().drain() {
        session.alive.store(false, Ordering::Relaxed);
        reap(session.child);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyManager>, id: String) -> Result<(), String> {
    if let Some(session) = state.0.lock().unwrap().remove(&id) {
        session.alive.store(false, Ordering::Relaxed);
        reap(session.child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(scanner: &mut TitleScanner, s: &str) -> Option<u8> {
        scanner.feed(s.as_bytes())
    }

    #[test]
    fn claude_titles_classify() {
        let mut s = TitleScanner::new();
        assert_eq!(feed(&mut s, "\x1b]0;✳ Claude Code\x07"), Some(TITLE_IDLE));
        assert_eq!(feed(&mut s, "\x1b]0;◐ Fix the bug\x07"), Some(TITLE_WORKING));
        assert_eq!(feed(&mut s, "\x1b]0;◑ Fix the bug\x07"), Some(TITLE_WORKING));
    }

    #[test]
    fn last_title_in_chunk_wins() {
        let mut s = TitleScanner::new();
        assert_eq!(
            feed(&mut s, "\x1b]0;◐ working\x07 …output… \x1b]0;✳ done\x07"),
            Some(TITLE_IDLE)
        );
    }

    #[test]
    fn sequence_split_across_reads() {
        let mut s = TitleScanner::new();
        assert_eq!(feed(&mut s, "\x1b]0;◐ Fix"), None);
        // the glyph itself can split mid-UTF-8 too
        let bytes = "\x1b]0;✳ hi\x07".as_bytes();
        assert_eq!(feed(&mut s, " it\x07"), Some(TITLE_WORKING));
        assert_eq!(s.feed(&bytes[..6]), None);
        assert_eq!(s.feed(&bytes[6..]), Some(TITLE_IDLE));
    }

    #[test]
    fn st_terminator_and_osc2() {
        let mut s = TitleScanner::new();
        assert_eq!(feed(&mut s, "\x1b]2;◐ via osc2\x1b\\"), Some(TITLE_WORKING));
    }

    #[test]
    fn foreign_titles_reset_to_unknown() {
        let mut s = TitleScanner::new();
        // the shell retitling after claude exits must clear claude's state
        assert_eq!(feed(&mut s, "\x1b]0;~/Projects/zero\x07"), Some(TITLE_UNKNOWN));
        // other OSC codes (hyperlinks, colors) say nothing at all
        assert_eq!(feed(&mut s, "\x1b]8;;http://x\x07"), None);
        assert_eq!(feed(&mut s, "\x1b]10;?\x07"), None);
    }

    #[test]
    fn oversize_sequence_is_abandoned() {
        let mut s = TitleScanner::new();
        let long = format!("\x1b]0;{}\x07\x1b]0;✳ ok\x07", "x".repeat(4096));
        assert_eq!(feed(&mut s, &long), Some(TITLE_IDLE));
    }

    #[test]
    fn esc_inside_osc_that_is_not_st() {
        let mut s = TitleScanner::new();
        // a mangled sequence is dropped, and the stray ESC can still open
        // a fresh one
        assert_eq!(feed(&mut s, "\x1b]0;junk\x1b]0;✳ ok\x07"), Some(TITLE_IDLE));
    }
}

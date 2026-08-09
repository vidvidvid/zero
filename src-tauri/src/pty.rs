use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    let reader_last = last_output.clone();
    let reader_input = last_input.clone();
    let reader_burst = burst_start.clone();
    let reader_alive = alive.clone();
    let reader_id = id.clone();
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !reader_alive.load(Ordering::Relaxed) {
                        break;
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
}

/// One `ps` sweep, then walk each shell's descendants looking for `claude`
/// (the CLI sets its own process name, so comm matches exactly).
///
/// Async because this polls once a second: as a sync command Tauri would run
/// the `ps` sweep on the main thread, and every sweep was a hitch in whatever
/// the window was doing — a tab drag twitching once a second, for instance.
#[tauri::command]
pub async fn claude_status(state: tauri::State<'_, PtyManager>) -> Result<Vec<ClaudeStat>, ()> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output();
    let mut children: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
    if let Ok(out) = out {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            // ps pads its columns ("  1609  1257 claude"), so split on runs of
            // whitespace — splitn on single chars yields empty fields here
            let mut it = line.split_whitespace();
            let (Some(pid), Some(ppid), Some(comm)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                let name = comm.rsplit('/').next().unwrap_or("").to_string();
                children.entry(ppid).or_default().push((pid, name));
            }
        }
    }

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
            ClaudeStat {
                cwd: s.cwd.clone(),
                running: s.shell_pid.is_some_and(|p| has_claude(&children, p, 0)),
                quiet_ms: now.saturating_sub(last),
                burst_ms: last.saturating_sub(s.burst_start.load(Ordering::Relaxed)),
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

/// Kill every session — called on frontend boot so a webview reload
/// (e.g. after a content-process crash) can't leak orphaned shells.
#[tauri::command]
pub fn pty_kill_all(state: tauri::State<PtyManager>) -> Result<(), String> {
    for (_, mut session) in state.0.lock().unwrap().drain() {
        session.alive.store(false, Ordering::Relaxed);
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&id) {
        session.alive.store(false, Ordering::Relaxed);
        let _ = session.child.kill();
    }
    Ok(())
}

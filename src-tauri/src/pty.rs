//! The app's end of the pty daemon.
//!
//! Every command here used to do the thing it is named after. Now each one is
//! a frame on a socket, and the shells live in a process of their own — see
//! `ptyd::server` for why that process is this same binary re-executed.
//!
//! The frontend cannot tell. Command names, arguments, return shapes and the
//! `pty-output` / `pty-exit` events are all exactly what they were, which is
//! the point of doing the move before doing anything with it: whatever breaks
//! in this step broke in the transport.

use crate::ptyd::proto;
use serde::Deserialize;
use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// How long to wait for the daemon to answer a request that has one.
///
/// Only spawn and status are answered, and both are the far side of a socket
/// on the same machine — this is not a deadline anything should ever reach.
/// It exists so that a daemon that has wedged surfaces as a pane saying so,
/// rather than as a promise the frontend waits on forever.
const REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How long the daemon has to come up and accept a connection at launch.
///
/// Short, because this runs on the main thread during `setup` and every
/// millisecond of it is a millisecond before the window exists. A daemon that
/// has not bound in two seconds is not going to.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// How long to wait for the daemon to acknowledge the hello.
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Deserialize, Default)]
struct Reply {
    req: u64,
    /// `None` on success. Carries the daemon's own message on failure — the
    /// text a pane prints when its shell won't start.
    error: Option<String>,
    /// Only `C_STATUS` fills this in.
    status: Option<serde_json::Value>,
}

/// The live connection. Everything on it is shared: commands write frames from
/// whichever thread Tauri ran them on, and the reader thread wakes whoever is
/// waiting on a reply.
pub struct Client {
    out: Mutex<UnixStream>,
    /// Request ids are only ever compared for equality, so wrapping would take
    /// 2^64 spawns to matter.
    next_req: AtomicU64,
    waiters: Mutex<HashMap<u64, Sender<Reply>>>,
}

impl Client {
    /// One frame, no answer expected — keystrokes, resizes, kills. A failed
    /// write means the daemon has gone; the caller has nothing better to do
    /// with that than the reader thread already does.
    fn send(&self, tag: u8, body: &[u8]) {
        if let Ok(mut s) = self.out.lock() {
            let _ = proto::write_frame(&mut *s, tag, body);
        }
    }

    /// One frame and the reply to it. Blocking, so every caller goes through
    /// the blocking pool.
    fn request(&self, tag: u8, mut body: serde_json::Value) -> Result<Reply, String> {
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        body["req"] = req.into();
        let (tx, rx) = channel();
        // registered before the frame goes out: the daemon can answer a spawn
        // faster than this thread gets rescheduled, and a reply with nobody
        // waiting for it is dropped
        self.waiters.lock().unwrap().insert(req, tx);
        self.send(tag, body.to_string().as_bytes());
        let got = rx.recv_timeout(REPLY_TIMEOUT);
        self.waiters.lock().unwrap().remove(&req);
        got.map_err(|_| "pty daemon did not answer".to_string())
    }
}

/// `None` until the daemon is up, and again if it dies. Commands that arrive
/// meanwhile fail the way a command against a dead shell always did.
#[derive(Default)]
pub struct PtyManager(Mutex<Option<Arc<Client>>>);

fn client(state: &tauri::State<'_, PtyManager>) -> Result<Arc<Client>, String> {
    state.0.lock().unwrap().clone().ok_or_else(|| "pty daemon not running".into())
}

// ── bringing the daemon up ───────────────────────────────────────────────────

/// Where the daemon's socket lives.
///
/// Under `TMPDIR`, which on macOS is a private per-user directory cleared on
/// reboot — and that is exactly the bound this feature claims. Terminals
/// survive quitting and updating zero; they do not survive a restart of the
/// machine, and a socket that disappears with the reboot is the honest way to
/// say so.
///
/// The name is keyed to *which copy of zero this is*, not to a run of it. A
/// run-scoped name could never be found again, which was fine while the daemon
/// died with the app and is the whole problem now. Hashing the executable path
/// keeps the installed app and a `tauri dev` build on separate daemons — the
/// two-zeros hazard the project has already been bitten by — while an update,
/// which replaces the binary at the same path, correctly finds the daemon
/// holding its shells.
fn socket_path() -> std::path::PathBuf {
    // FNV-1a rather than DefaultHasher: this name has to mean the same thing
    // to a build made months apart, and the standard hasher makes no such
    // promise across toolchains. A rustc upgrade must not orphan a daemon.
    let exe = std::env::current_exe().unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in exe.to_string_lossy().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // the protocol version is in the name too — see `proto::VERSION` for why
    // that beats negotiating it once the connection is open
    std::env::temp_dir().join(format!("zero-ptyd-{hash:016x}-v{}.sock", proto::VERSION))
}

/// Attach to the daemon, starting one if there isn't already one running.
///
/// The order matters and is the reattach path in miniature: connecting first
/// means a daemon left over from the last run of zero — holding its shells,
/// still keeping their screens — is joined rather than duplicated. Only when
/// nothing answers is a new one started.
///
/// Called from `setup`, so the socket is up before the webview has finished
/// loading, let alone asked for a shell. Failure is not fatal and is not
/// hidden: it leaves the client `None`, every pty command then answers with
/// the error above, and a pane prints it where the shell would have been.
pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let sock = socket_path();
    // Twice, because a daemon can be on its way out at the very moment we
    // reach it: `reaper` exits the process as soon as it is empty and past the
    // grace window, so `connect` can succeed against a socket that is about to
    // EOF. The first attempt joins whatever is there; the second insists on a
    // daemon of its own. Without the retry that race boots an app whose every
    // terminal is dead until it is restarted — the one outcome this feature
    // exists to prevent.
    let mut failure = String::new();
    for insist_on_fresh in [false, true] {
        match connect_verified(&sock, insist_on_fresh) {
            Ok(stream) => return install(app, stream),
            Err(e) => failure = e,
        }
    }
    Err(failure)
}

/// Reach a daemon and refuse to believe in it until it answers.
fn connect_verified(sock: &std::path::Path, insist_on_fresh: bool) -> Result<UnixStream, String> {
    let mut stream = if insist_on_fresh {
        // whatever was there did not answer; it is either wedged or leaving,
        // and either way this socket is not worth joining
        let _ = std::fs::remove_file(sock);
        spawn_daemon(sock)?;
        connect_retry(sock)?
    } else {
        match UnixStream::connect(sock) {
            Ok(existing) => existing,
            Err(_) => {
                spawn_daemon(sock)?;
                connect_retry(sock)?
            }
        }
    };

    // Declare ourselves, and wait to be acknowledged. Anything that arrives
    // before the acknowledgement is output for sessions this app has not
    // claimed yet, which the replay on attach will send again in full — so
    // dropping it here costs nothing.
    stream.set_read_timeout(Some(HELLO_TIMEOUT)).ok();
    proto::write_frame(&mut stream, proto::C_HELLO, br#"{"app":true,"req":0}"#)
        .map_err(|e| format!("hello: {e}"))?;
    loop {
        let (tag, _) = proto::read_frame(&mut stream)
            .map_err(|e| format!("daemon did not acknowledge: {e}"))?;
        if tag == proto::D_REPLY {
            break;
        }
    }
    stream.set_read_timeout(None).ok();
    Ok(stream)
}

/// Hand the verified connection to the rest of the app.
fn install(app: &tauri::AppHandle, stream: UnixStream) -> Result<(), String> {
    let read_half = stream.try_clone().map_err(|e| e.to_string())?;
    let client = Arc::new(Client {
        out: Mutex::new(stream),
        next_req: AtomicU64::new(1),
        waiters: Mutex::new(HashMap::new()),
    });
    *app.state::<PtyManager>().0.lock().unwrap() = Some(client.clone());

    let app = app.clone();
    std::thread::spawn(move || pump(app, client, read_half));
    Ok(())
}

/// Start a daemon of our own.
///
/// `process_group(0)` is what makes it a daemon rather than a child. Without
/// it the new process stays in zero's process group and takes every group
/// signal zero takes — a ⌃C in the terminal running `tauri dev`, or the group
/// kill that ends a dev session, would go straight through to the shells it is
/// holding. Surviving the app's death is the entire feature; inheriting the
/// app's signals would quietly undo it.
///
/// Its stdio is replaced rather than inherited, and that is not tidiness.
/// `tauri dev` hands the app a *pipe* for stderr and stops reading it the
/// moment it exits — leaving a daemon that outlives it holding a pipe with no
/// reader, on which `eprintln!` panics. A panic in a thread holding the
/// session map poisoned it, and the daemon went on accepting connections while
/// answering none of them: every pane came up saying the daemon did not
/// answer, with the shells all still running behind it. A process meant to
/// outlive its parent must not keep its parent's pipes.
///
/// The environment, by contrast, is deliberately *not* sanitised: the daemon
/// inherits this process's, because that is what the shells it spawns have
/// always inherited. PATH in particular is the one launchd hands a
/// Dock-launched app, which `spawn_or_attach` patches up rather than replaces.
fn spawn_daemon(sock: &std::path::Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    // Somewhere of its own to talk, so losing the parent's pipe costs a log
    // file rather than the terminals. Truncated per daemon, next to the socket
    // and cleaned up by the same system that cleans that up.
    let log = sock.with_extension("log");
    let out = std::fs::File::create(&log).map_err(|e| format!("daemon log {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    std::process::Command::new(&exe)
        .arg("--ptyd")
        .arg(sock)
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(out))
        .stderr(std::process::Stdio::from(err))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn daemon: {e}"))
}

/// Wait for a just-started daemon to bind and accept.
///
/// Polling because there is no way to wait on a socket that does not exist
/// yet: between exec and bind there is nothing on the filesystem to watch.
fn connect_retry(sock: &std::path::Path) -> Result<UnixStream, String> {
    let started = std::time::Instant::now();
    loop {
        match UnixStream::connect(sock) {
            Ok(s) => return Ok(s),
            Err(e) if started.elapsed() > CONNECT_TIMEOUT => {
                return Err(format!("connect {}: {e}", sock.display()))
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(5)),
        }
    }
}

/// Everything the daemon says, for as long as it says anything.
///
/// This is the same dispatch the reader threads used to do inline, one process
/// further out: bytes become a `pty-output` event, an exit becomes
/// `pty-exit`, and a reply wakes the command waiting on it.
fn pump(app: tauri::AppHandle, client: Arc<Client>, mut r: UnixStream) {
    #[derive(serde::Serialize, Clone)]
    struct PtyOutput {
        id: String,
        bytes: Vec<u8>,
    }
    #[derive(serde::Serialize, Clone)]
    struct PtyExit {
        id: String,
    }

    while let Ok((tag, body)) = proto::read_frame(&mut r) {
        match tag {
            proto::D_OUTPUT => {
                if let Some((id, bytes)) = proto::decode_bytes(&body) {
                    let _ = app.emit("pty-output", PtyOutput { id, bytes: bytes.to_vec() });
                }
            }
            proto::D_EXIT => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
                    let id = v["id"].as_str().unwrap_or_default().to_string();
                    let _ = app.emit("pty-exit", PtyExit { id });
                }
            }
            proto::D_REPLY => {
                if let Ok(reply) = serde_json::from_slice::<Reply>(&body) {
                    if let Some(tx) = client.waiters.lock().unwrap().remove(&reply.req) {
                        let _ = tx.send(reply);
                    }
                }
            }
            _ => {}
        }
    }

    // The daemon is gone. Dropping the client is what makes every later
    // command say so instead of writing into a socket nobody is reading.
    *app.state::<PtyManager>().0.lock().unwrap() = None;
}

// ── the escape hatch ─────────────────────────────────────────────────────────

/// Every daemon on this machine speaking our protocol version.
///
/// Not just this executable's. The socket name is keyed to the executable path
/// so that an installed app and a `tauri dev` build never share a daemon — but
/// the escape hatch has to reach *both*, and the shell shim always runs the
/// installed binary. Keying the hatch the same way as the app made it blind to
/// exactly the build most likely to have wedged: the one being worked on.
fn all_sockets() -> Vec<std::path::PathBuf> {
    let suffix = format!("-v{}.sock", proto::VERSION);
    let mut found: Vec<std::path::PathBuf> = std::fs::read_dir(std::env::temp_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("zero-ptyd-") && name.ends_with(&suffix)
        })
        .map(|e| e.path())
        .collect();
    found.sort();
    found
}

/// Ask one daemon what it is holding. `None` if it is there but not answering,
/// which is worth telling apart from not being there at all.
fn ask(sock: &std::path::Path, kill: bool) -> Option<Vec<serde_json::Value>> {
    let stream = UnixStream::connect(sock).ok()?;
    let read_half = stream.try_clone().ok()?;
    let client = Arc::new(Client {
        out: Mutex::new(stream),
        next_req: AtomicU64::new(1),
        waiters: Mutex::new(HashMap::new()),
    });
    {
        let client = client.clone();
        std::thread::spawn(move || {
            let mut r = read_half;
            while let Ok((tag, body)) = proto::read_frame(&mut r) {
                if tag != proto::D_REPLY {
                    continue;
                }
                if let Ok(reply) = serde_json::from_slice::<Reply>(&body) {
                    if let Some(tx) = client.waiters.lock().unwrap().remove(&reply.req) {
                        let _ = tx.send(reply);
                    }
                }
            }
        });
    }
    if kill {
        client.send(proto::C_KILL_ALL, &[]);
    }
    // Always ends with a question, kill or not. `C_KILL_ALL` is not answered,
    // so a kill that reported success on its own would be asserting rather
    // than reporting — and against a daemon that has stopped answering it
    // would be asserting something false. What comes back here is what is
    // actually left.
    let status = client
        .request(proto::C_STATUS, serde_json::json!({}))
        .ok()?
        .status?;
    Some(status.as_array().cloned().unwrap_or_default())
}

/// `zero --sessions` and `zero --kill-sessions`, which do not start the app.
///
/// The reason these exist is the one thing session persistence takes away: you
/// can no longer fix a wedged terminal by restarting zero, because the shells
/// are the part that survives. A way out that lives only inside the app is no
/// way out at all in the case it is for — the app not starting, or not
/// responding — so this talks to the daemon directly and never touches Tauri.
///
/// Never returns: both are terminal commands in both senses.
pub fn cli(kill: bool) -> ! {
    let sockets = all_sockets();
    if sockets.is_empty() {
        println!("no zero terminal daemon running");
        std::process::exit(0);
    }

    let mut total = 0usize;
    let mut wedged = 0usize;
    for sock in &sockets {
        match ask(sock, kill) {
            Some(sessions) => {
                total += sessions.len();
                for s in &sessions {
                    let cwd = s["cwd"].as_str().unwrap_or("?");
                    let quiet = s["quiet_ms"].as_u64().unwrap_or(0) / 1000;
                    let what = match (s["running"].as_bool(), s["title_working"].as_bool()) {
                        (Some(true), Some(true)) => "claude, working".to_string(),
                        (Some(true), _) => "claude, waiting on you".to_string(),
                        _ => format!("shell, quiet {quiet}s"),
                    };
                    println!("  {cwd}  —  {what}");
                }
            }
            // Named, not swallowed. A daemon that holds the socket and will
            // not answer is the exact situation this command exists for, and
            // saying "no sessions" about it would be a lie.
            None => {
                wedged += 1;
                println!("  {} — not answering", sock.display());
            }
        }
    }

    if kill {
        match (total, wedged) {
            (0, 0) => println!("every zero terminal session ended"),
            (n, 0) => println!("{n} session(s) would not end — the daemon is still holding them"),
            (_, w) => println!("{w} daemon(s) never answered; their shells may still be running"),
        }
    } else if total == 0 && wedged == 0 {
        println!("daemon running, no sessions");
    } else {
        println!("\n{total} session(s) across {} daemon(s)", sockets.len());
        if wedged > 0 {
            println!("{wedged} not answering — end them with: zero --kill-sessions");
        } else {
            println!("end them all with: zero --kill-sessions");
        }
    }
    std::process::exit(0)
}

// ── the commands, unchanged as far as the frontend is concerned ──────────────

/// Async now, where it used to be sync, and for the reason `claude_status` was
/// already async: this waits for the daemon to answer, and waiting on the main
/// thread is a frozen window. `invoke` returned a promise either way, so
/// nothing on the other side changes.
#[tauri::command]
pub async fn pty_spawn(
    state: tauri::State<'_, PtyManager>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let client = client(&state)?;
    let body = serde_json::json!({ "id": id, "cwd": cwd, "cols": cols, "rows": rows });
    crate::git::blocking(move || match client.request(proto::C_SPAWN, body) {
        Ok(reply) => reply.error.map_or(Ok(()), Err),
        Err(e) => Err(e),
    })
    .await
}

/// Not answered, and that is on purpose: a keystroke that waited for a round
/// trip is a keystroke you could feel. The only error it can still report is
/// the daemon being gone entirely.
#[tauri::command]
pub fn pty_write(state: tauri::State<PtyManager>, id: String, data: String) -> Result<(), String> {
    client(&state)?.send(proto::C_WRITE, &proto::encode_bytes(&id, data.as_bytes()));
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let body = serde_json::json!({ "id": id, "cols": cols, "rows": rows });
    client(&state)?.send(proto::C_RESIZE, body.to_string().as_bytes());
    Ok(())
}

/// Kill every session, everywhere, now.
///
/// No longer what the frontend runs on boot — `pty_reap` is, and the
/// difference between them is the feature. This is the escape hatch instead:
/// the thing `zero --kill-sessions` calls when something has gone wrong badly
/// enough that you want the shells gone regardless of what is in them.
#[tauri::command]
pub fn pty_kill_all(state: tauri::State<PtyManager>) -> Result<(), String> {
    // A daemon that hasn't come up has nothing to reap, which is not an error
    // worth failing a boot over.
    if let Ok(client) = client(&state) {
        client.send(proto::C_KILL_ALL, &[]);
    }
    Ok(())
}

/// End every session no restored layout claims.
///
/// This replaced the unconditional `pty_kill_all` the frontend used to run on
/// boot, and the swap is the whole of persistence as far as the frontend is
/// concerned: instead of executing whatever survived, the app now says which
/// panes it still has and the daemon ends the rest. A webview reload is still
/// covered — a reload restores the same layout, so it claims the same ids and
/// nothing is lost — while a project closed last week is not claimed by
/// anyone, and goes.
#[tauri::command]
pub async fn pty_reap(state: tauri::State<'_, PtyManager>, keep: Vec<String>) -> Result<(), String> {
    let Ok(client) = client(&state) else { return Ok(()) };
    let body = serde_json::json!({ "keep": keep });
    crate::git::blocking(move || client.request(proto::C_REAP, body))
        .await
        .map(|_| ())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyManager>, id: String) -> Result<(), String> {
    let body = serde_json::json!({ "id": id });
    client(&state)?.send(proto::C_KILL, body.to_string().as_bytes());
    Ok(())
}

/// Passed through as JSON rather than re-typed on this side. The shape is
/// `ptyd::server::ClaudeStat`, it is defined once, and a second copy here
/// would only be a second thing to keep in step.
#[tauri::command]
pub async fn claude_status(state: tauri::State<'_, PtyManager>) -> Result<serde_json::Value, ()> {
    let Ok(client) = client(&state) else {
        return Ok(serde_json::Value::Array(vec![]));
    };
    Ok(
        crate::git::blocking(move || client.request(proto::C_STATUS, serde_json::json!({})))
            .await
            .ok()
            .and_then(|reply| reply.status)
            .unwrap_or_else(|| serde_json::Value::Array(vec![])),
    )
}

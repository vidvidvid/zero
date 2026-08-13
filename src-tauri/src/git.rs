use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

// Every command here is `async` on purpose. Tauri runs a *synchronous* command
// on the main thread, so a `git status` sweep — let alone `worktree remove`,
// which can take seconds — froze the whole window while it ran. Async commands
// are dispatched to the runtime's worker threads instead. The bodies stay
// blocking; it's the thread they block that matters.

/// A repository can name programs for git to run in its own `.git/config`, and
/// several of them fire on plain reads: `core.fsmonitor` and a
/// `filter.<name>.clean` selected by the repo's own `.gitattributes` both run
/// during `git status`. Since the worktree panel is the default sidebar tab and
/// polls status every three seconds, opening a repository that arrived with a
/// `.git` directory already in it — an archive, say — would be enough to run
/// someone else's command. So the automatic, read-only commands blank any local
/// config key that names a program.
///
/// Only keys set *in the repository* are blanked, never the user's own global
/// config: overriding that would quietly disable tools they chose to install.
/// And only the drive-by commands are hardened — staging, committing and
/// pushing leave config alone, because a clean filter that's been blanked would
/// stage the wrong bytes, and hooks are the whole point of committing. Those
/// are deliberate acts on a repository you've already decided to work in; the
/// hardened ones run whether you asked or not.
const EXEC_KEY_SUFFIX: &[&str] = &[
    "command", "hook", "hookspath", "helper", "pager", "editor", "program",
    "driver", "textconv", "clean", "smudge", "process", "fsmonitor",
    "external", "uploadpack", "receivepack",
];

/// Re-reading a repository's config on every poll would double the git
/// processes the panel spawns, so the answer is cached briefly. Config changes
/// mid-session are picked up within this long.
const OVERRIDE_TTL: Duration = Duration::from_secs(10);

type OverrideCache = Mutex<HashMap<String, (Instant, Arc<Vec<String>>)>>;

fn git_base(cwd: &str) -> Command {
    // launchd hands GUI apps a minimal PATH; git's helpers (ssh, credential
    // helpers, hooks) live in the usual places, so put them back
    let path = std::env::var("PATH").unwrap_or_default();
    let augmented = format!("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:{}", path);
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).env("PATH", augmented);
    cmd
}

fn finish(out: Output) -> Result<String, String> {
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if err.is_empty() { stdout } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `-c key=` for every program-naming key the repository sets. Listing config
/// executes nothing, which is what makes this safe to do first.
fn exec_key_overrides(cwd: &str) -> Arc<Vec<String>> {
    static CACHE: OnceLock<OverrideCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);

    if let Some((at, args)) = cache.lock().unwrap().get(cwd) {
        if at.elapsed() < OVERRIDE_TTL {
            return args.clone();
        }
    }

    let mut keys: HashSet<String> = HashSet::new();
    // --worktree falls back to --local unless extensions.worktreeConfig is on,
    // so the two together cover both without needing to ask which is in use
    for scope in ["--local", "--worktree"] {
        let Ok(out) = git_base(cwd)
            .args(["config", scope, "--list", "--name-only", "-z"])
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        for key in String::from_utf8_lossy(&out.stdout).split('\0') {
            let key = key.trim();
            // git lowercases section and key, but not the subsection between
            let last = key.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
            if !key.is_empty() && EXEC_KEY_SUFFIX.iter().any(|s| last.ends_with(s)) {
                keys.insert(key.to_string());
            }
        }
    }

    let mut args = Vec::with_capacity(keys.len() * 2);
    for key in keys {
        args.push("-c".to_string());
        args.push(format!("{key}="));
    }
    let args = Arc::new(args);
    cache.lock().unwrap().insert(cwd.to_string(), (Instant::now(), args.clone()));
    args
}

/// For commands that run on their own — everything the panel polls. Neutralises
/// the repository's program-naming config first; see [`EXEC_KEY_SUFFIX`].
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let overrides = exec_key_overrides(cwd);
    let out = git_base(cwd)
        .args(overrides.iter())
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    finish(out)
}

/// For commands only ever run because you asked for them, where the
/// repository's own filters, hooks and credential helpers have to work.
fn run_git_trusted(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git_base(cwd).args(args).output().map_err(|e| e.to_string())?;
    finish(out)
}

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}

#[tauri::command]
pub async fn git_worktrees(root: String) -> Result<Vec<Worktree>, String> {
    let out = run_git(&root, &["worktree", "list", "--porcelain"])?;
    let mut result = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    for line in out.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if !path.is_empty() {
                let is_main = Path::new(&path).join(".git").is_dir();
                result.push(Worktree {
                    path: path.clone(),
                    branch: branch.clone(),
                    is_main,
                });
            }
            path.clear();
            branch.clear();
        } else if let Some(p) = line.strip_prefix("worktree ") {
            path = p.to_string();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            branch = b.to_string();
        } else if line == "detached" {
            branch = "(detached)".to_string();
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn git_worktree_remove(root: String, path: String, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    // `--` so a worktree whose path begins with a dash isn't read as an option
    args.push("--");
    args.push(&path);
    run_git_trusted(&root, &args)?;
    Ok(())
}

#[derive(Serialize)]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[tauri::command]
pub async fn git_status(worktree: String) -> Result<Vec<FileChange>, String> {
    let out = run_git(&worktree, &["status", "--porcelain=v1"])?;
    let mut result = Vec::new();
    for line in out.lines() {
        if line.len() < 4 {
            continue;
        }
        let x = line.chars().next().unwrap();
        let y = line.chars().nth(1).unwrap();
        let mut path = line[3..].to_string();
        // renames come as "old -> new"; show the new path
        if let Some(idx) = path.find(" -> ") {
            path = path[idx + 4..].to_string();
        }
        if x == '?' {
            result.push(FileChange { path, status: "U".into(), staged: false });
            continue;
        }
        // a file can be in both lists at once ("MM" = staged edit + newer edit)
        if x != ' ' {
            result.push(FileChange { path: path.clone(), status: x.to_string(), staged: true });
        }
        if y != ' ' {
            result.push(FileChange { path, status: y.to_string(), staged: false });
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn git_stage(worktree: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run_git_trusted(&worktree, &args)?;
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(worktree: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    // repos without a commit yet have no HEAD to restore from
    if run_git_trusted(&worktree, &args).is_err() {
        let mut fallback = vec!["rm", "--cached", "-r", "-q", "--"];
        fallback.extend(paths.iter().map(|s| s.as_str()));
        run_git_trusted(&worktree, &fallback)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(worktree: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("empty commit message".into());
    }
    run_git_trusted(&worktree, &["commit", "-m", &message])
}

#[tauri::command]
pub async fn git_push(worktree: String) -> Result<String, String> {
    // no upstream yet: publish the branch instead of failing
    match run_git_trusted(&worktree, &["push"]) {
        Ok(out) => Ok(out),
        Err(e) if e.contains("no upstream") || e.contains("--set-upstream") => {
            run_git_trusted(&worktree, &["push", "--set-upstream", "origin", "HEAD"])
        }
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub branch: String,
    pub upstream: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[tauri::command]
pub async fn git_branch_info(worktree: String) -> Result<BranchInfo, String> {
    let branch = run_git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    // "<behind>\t<ahead>" relative to the upstream, or an error when unset
    match run_git(&worktree, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
        Ok(counts) => {
            let mut it = counts.split_whitespace();
            let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            Ok(BranchInfo { branch, upstream: true, ahead, behind })
        }
        Err(_) => {
            let ahead = run_git(&worktree, &["rev-list", "--count", "HEAD"])
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            Ok(BranchInfo { branch, upstream: false, ahead, behind: 0 })
        }
    }
}

/// File content at HEAD; empty string for files that don't exist there (new files).
#[tauri::command]
pub async fn git_head_file(worktree: String, path: String) -> String {
    run_git(&worktree, &["show", &format!("HEAD:{}", path)]).unwrap_or_default()
}

#[derive(Serialize)]
pub struct Baseline {
    /// the file as it was committed
    pub content: String,
    /// false when HEAD has no such file. A new file gets no change bars at all
    /// rather than every one of its lines marked as added — the same call VS
    /// Code makes, and the file tree is where "this is new" gets said instead.
    pub tracked: bool,
}

/// The committed version of a file, found without being told which repository
/// it belongs to.
///
/// The editor opens files from anywhere — another worktree, a path outside the
/// project entirely — so the caller genuinely doesn't know the repository root.
/// `HEAD:./name` resolves relative to git's own working directory, which turns
/// the whole question into "run it in the file's folder": no root to find, no
/// path arithmetic, and none of the ways that arithmetic goes wrong when a
/// path arrives through a symlink.
#[tauri::command]
pub async fn git_baseline(path: String) -> Baseline {
    let untracked = || Baseline { content: String::new(), tracked: false };
    let p = Path::new(&path);
    let (Some(dir), Some(name)) = (p.parent(), p.file_name()) else {
        return untracked();
    };
    match run_git(
        &dir.to_string_lossy(),
        &["show", &format!("HEAD:./{}", name.to_string_lossy())],
    ) {
        Ok(content) => Baseline { content, tracked: true },
        Err(_) => untracked(),
    }
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    /// the repository ignores this, so the tree can grey it out
    pub ignored: bool,
}

/// Which of these names the repository ignores.
///
/// One `git check-ignore` for the whole directory rather than one per entry —
/// the tree lists a directory at a time, so this costs one extra process per
/// folder you open, not one per file in it.
fn ignored_names(dir: &str, entries: &[(String, bool)]) -> HashSet<String> {
    use std::io::Write;
    use std::process::Stdio;

    if entries.is_empty() {
        return HashSet::new();
    }
    let mut payload = Vec::new();
    for (name, is_dir) in entries {
        payload.extend_from_slice(name.as_bytes());
        // the trailing slash tells git it's a directory, without which a
        // directory-only pattern like `build/` wouldn't match
        if *is_dir {
            payload.push(b'/');
        }
        payload.push(0);
    }

    let Ok(mut child) = git_base(dir)
        .args(exec_key_overrides(dir).iter())
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        // not a repository, or no git: nothing is ignored
        return HashSet::new();
    };
    // written from its own thread: a large directory can fill the pipe before
    // git has read any of it, and then both sides sit waiting for the other
    if let Some(mut sink) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = sink.write_all(&payload);
        });
    }
    let Ok(out) = child.wait_with_output() else {
        return HashSet::new();
    };
    // check-ignore echoes back only the paths it matched, as we sent them
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .collect()
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<(String, bool)> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some((name, is_dir))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));

    let ignored = ignored_names(&path, &entries);
    Ok(entries
        .into_iter()
        .map(|(name, is_dir)| DirEntry {
            ignored: ignored.contains(&name),
            name,
            is_dir,
        })
        .collect())
}

/// Past this, the list is more than anyone scrolls and the filter starts to
/// cost more than it returns.
const MAX_PROJECT_FILES: usize = 20_000;

/// Every file in the project worth opening: tracked, plus anything new that
/// isn't ignored. The same set `git grep` searches, and the same set VS Code's
/// quick open offers — which is why neither needs to read .gitignore itself.
pub fn project_files(root: &str) -> Result<Vec<String>, String> {
    let out = run_git(
        root,
        &["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    )?;
    let mut seen = std::collections::HashSet::new();
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter(|p| seen.insert(p.to_string()))
        .take(MAX_PROJECT_FILES)
        .map(str::to_string)
        .collect())
}

#[tauri::command]
pub async fn list_project_files(root: String) -> Result<Vec<String>, String> {
    project_files(&root)
}

/// A file as bytes rather than text, for the things that aren't text.
///
/// `tauri::ipc::Response` puts the bytes on the IPC channel raw. Returning a
/// `Vec<u8>` would have serialised a megabyte image as a JSON array of a
/// million numbers, and encoding it as a data: URI instead would still cost a
/// third again in base64 — this way the frontend gets an ArrayBuffer it can
/// wrap in a Blob directly.
#[tauri::command]
pub async fn read_binary(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A repository that tries to run a command when its status is read. Both
    /// of these fire under plain `git status`: fsmonitor directly, and the
    /// clean filter because .gitattributes points every file at it.
    fn hostile_repo(dir: &Path, marker: &Path) {
        let git = |args: &[&str]| {
            git_base(&dir.to_string_lossy()).args(args).output().unwrap();
        };
        std::fs::create_dir_all(dir).unwrap();
        git(&["init", "-q", "."]);
        std::fs::write(dir.join(".gitattributes"), "* filter=trap\n").unwrap();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
        // a change to make status consult the filter
        std::fs::write(dir.join("f.txt"), "two\n").unwrap();

        let touch = format!("touch {}", marker.display());
        git(&["config", "core.fsmonitor", &touch]);
        git(&["config", "filter.trap.clean", &format!("sh -c '{touch}; cat'")]);
    }

    /// Directories are the case that breaks: a `build/` pattern only matches a
    /// path git believes is a directory, which it can only know from the
    /// trailing slash we send.
    #[test]
    fn ignored_names_covers_files_and_directories() {
        let dir = std::env::temp_dir().join("zero-ignore-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        git_base(&cwd).args(["init", "-q", "."]).output().unwrap();
        std::fs::write(dir.join(".gitignore"), "build/\n*.log\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "").unwrap();
        std::fs::write(dir.join("noise.log"), "").unwrap();

        let entries = vec![
            ("build".to_string(), true),
            ("src".to_string(), true),
            ("keep.txt".to_string(), false),
            ("noise.log".to_string(), false),
        ];
        let ignored = ignored_names(&cwd, &entries);

        assert!(ignored.contains("build"), "directory-only pattern missed: {ignored:?}");
        assert!(ignored.contains("noise.log"), "file pattern missed: {ignored:?}");
        assert!(!ignored.contains("src"), "plain directory marked ignored: {ignored:?}");
        assert!(!ignored.contains("keep.txt"), "plain file marked ignored: {ignored:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_does_not_run_the_repositorys_commands() {
        let dir = std::env::temp_dir().join("zero-git-hardening-test");
        let marker = std::env::temp_dir().join("zero-git-hardening-marker");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&marker);
        hostile_repo(&dir, &marker);
        let cwd = dir.to_string_lossy().to_string();

        // the hardened path must not let either one run
        run_git(&cwd, &["status", "--porcelain=v1"]).unwrap();
        assert!(!marker.exists(), "repository config was executed by git status");

        // and the guard has to be doing it — without the overrides it fires,
        // which is what makes the assertion above meaningful
        run_git_trusted(&cwd, &["status", "--porcelain=v1"]).unwrap();
        assert!(marker.exists(), "test no longer reproduces the original issue");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&marker);
    }
}

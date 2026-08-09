use serde::Serialize;
use std::path::Path;
use std::process::Command;

// Every command here is `async` on purpose. Tauri runs a *synchronous* command
// on the main thread, so a `git status` sweep — let alone `worktree remove`,
// which can take seconds — froze the whole window while it ran. Async commands
// are dispatched to the runtime's worker threads instead. The bodies stay
// blocking; it's the thread they block that matters.

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    // launchd hands GUI apps a minimal PATH; git's helpers (ssh, credential
    // helpers, hooks) live in the usual places, so put them back
    let path = std::env::var("PATH").unwrap_or_default();
    let augmented = format!("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:{}", path);
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", augmented)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if err.is_empty() { stdout } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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
    args.push(&path);
    run_git(&root, &args)?;
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
    run_git(&worktree, &args)?;
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(worktree: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    // repos without a commit yet have no HEAD to restore from
    if run_git(&worktree, &args).is_err() {
        let mut fallback = vec!["rm", "--cached", "-r", "-q", "--"];
        fallback.extend(paths.iter().map(|s| s.as_str()));
        run_git(&worktree, &fallback)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(worktree: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("empty commit message".into());
    }
    run_git(&worktree, &["commit", "-m", &message])
}

#[tauri::command]
pub async fn git_push(worktree: String) -> Result<String, String> {
    // no upstream yet: publish the branch instead of failing
    match run_git(&worktree, &["push"]) {
        Ok(out) => Ok(out),
        Err(e) if e.contains("no upstream") || e.contains("--set-upstream") => {
            run_git(&worktree, &["push", "--set-upstream", "origin", "HEAD"])
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
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some(DirEntry { name, is_dir })
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub text: String,
}

#[tauri::command]
pub async fn search_project(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    // launchd's minimal PATH won't include homebrew — try known locations
    let out = ["rg", "/opt/homebrew/bin/rg", "/usr/local/bin/rg"]
        .iter()
        .find_map(|rg| {
            Command::new(rg)
                .args(["--line-number", "--no-heading", "--color=never", "-S", "--max-count", "50", "--", &query])
                .current_dir(&root)
                .output()
                .ok()
        })
        .ok_or("ripgrep not found (looked on PATH, /opt/homebrew/bin, /usr/local/bin)")?;
    // rg exits 1 on "no matches" — not an error for us
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut hits = Vec::new();
    for line in stdout.lines().take(500) {
        let mut parts = line.splitn(3, ':');
        if let (Some(p), Some(l), Some(t)) = (parts.next(), parts.next(), parts.next()) {
            if let Ok(ln) = l.parse::<u64>() {
                hits.push(SearchHit {
                    path: p.to_string(),
                    line: ln,
                    text: t.trim().chars().take(200).collect(),
                });
            }
        }
    }
    Ok(hits)
}

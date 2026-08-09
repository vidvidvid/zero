use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("recents.json"))
}

fn load(app: &tauri::AppHandle) -> Vec<RecentProject> {
    store_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &tauri::AppHandle, list: &[RecentProject]) -> Result<(), String> {
    let p = store_path(app)?;
    fs::write(p, serde_json::to_string_pretty(list).unwrap()).map_err(|e| e.to_string())
}

/// A main worktree has a .git *directory*; linked worktrees have a .git file.
fn is_main_worktree(path: &str) -> bool {
    PathBuf::from(path).join(".git").is_dir()
}

#[tauri::command]
pub fn get_recents(app: tauri::AppHandle) -> Vec<RecentProject> {
    load(&app)
        .into_iter()
        .filter(|r| is_main_worktree(&r.path))
        .collect()
}

#[tauri::command]
pub fn add_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !is_main_worktree(&path) {
        return Err("not a main git worktree".into());
    }
    let name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let mut list = load(&app);
    list.retain(|r| r.path != path);
    list.insert(0, RecentProject { path, name });
    list.truncate(30);
    save(&app, &list)
}

#[tauri::command]
pub fn remove_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut list = load(&app);
    list.retain(|r| r.path != path);
    save(&app, &list)
}

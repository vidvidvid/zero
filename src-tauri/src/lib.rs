mod cli;
mod git;
mod links;
#[cfg(target_os = "macos")]
mod high_refresh;
mod pty;
mod recents;
mod search;

use pty::PtyManager;

/// The webview console isn't forwarded to the terminal running `tauri dev`,
/// which makes frontend state invisible while debugging. This puts it on stdout.
#[tauri::command]
fn debug_log(msg: String) {
    println!("[web] {msg}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .setup(|_app| {
            // the `zero` shell command comes with the app, so installing the
            // app is the whole install
            match cli::install_command() {
                Ok(what) => println!("[cli] ~/.local/bin/zero {what}"),
                Err(e) => println!("[cli] no shell command: {e}"),
            }
            cli::watch(_app.handle().clone());

            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        match high_refresh::unlock(webview.inner()) {
                            Ok(()) => println!("[fps] display-rate rendering unlocked"),
                            Err(e) => println!("[fps] still clamped to 60: {e}"),
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            debug_log,
            links::open_url,
            links::reveal_path,
            links::resolve_paths,
            recents::get_recents,
            recents::add_recent,
            recents::remove_recent,
            recents::existing_dirs,
            git::git_worktrees,
            git::git_worktree_remove,
            pty::claude_status,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            git::git_branch_info,
            git::git_head_file,
            git::git_baseline,
            git::list_dir,
            git::list_project_files,
            git::read_file,
            git::read_binary,
            git::write_file,
            search::search_project,
            search::replace_matches,
            pty::pty_kill_all,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

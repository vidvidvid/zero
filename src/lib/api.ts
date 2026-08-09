import { invoke } from "@tauri-apps/api/core";

export interface RecentProject {
  path: string;
  name: string;
}

export interface Worktree {
  path: string;
  branch: string;
  is_main: boolean;
}

export interface FileChange {
  path: string;
  status: string;
  staged: boolean;
}

export interface BranchInfo {
  branch: string;
  upstream: boolean;
  ahead: number;
  behind: number;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export interface ClaudeStat {
  cwd: string;
  running: boolean;
  quiet_ms: number;
  burst_ms: number;
}

export const api = {
  claudeStatus: () => invoke<ClaudeStat[]>("claude_status"),
  getRecents: () => invoke<RecentProject[]>("get_recents"),
  addRecent: (path: string) => invoke<void>("add_recent", { path }),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  worktrees: (root: string) => invoke<Worktree[]>("git_worktrees", { root }),
  worktreeRemove: (root: string, path: string, force: boolean) =>
    invoke<void>("git_worktree_remove", { root, path, force }),
  gitStatus: (worktree: string) => invoke<FileChange[]>("git_status", { worktree }),
  gitStage: (worktree: string, paths: string[]) => invoke<void>("git_stage", { worktree, paths }),
  gitUnstage: (worktree: string, paths: string[]) => invoke<void>("git_unstage", { worktree, paths }),
  gitCommit: (worktree: string, message: string) =>
    invoke<string>("git_commit", { worktree, message }),
  gitPush: (worktree: string) => invoke<string>("git_push", { worktree }),
  branchInfo: (worktree: string) => invoke<BranchInfo>("git_branch_info", { worktree }),
  headFile: (worktree: string, path: string) => invoke<string>("git_head_file", { worktree, path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  projectFiles: (root: string) => invoke<string[]>("list_project_files", { root }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  ptyKillAll: () => invoke<void>("pty_kill_all"),
  ptySpawn: (id: string, cwd: string, cols: number, rows: number) =>
    invoke<void>("pty_spawn", { id, cwd, cols, rows }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
};

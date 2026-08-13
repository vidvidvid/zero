import { invoke } from "@tauri-apps/api/core";
import type { ResolvedPath } from "./termLinks";

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

export interface Baseline {
  content: string;
  /** false when HEAD has no such file — a new file, which gets no change bars */
  tracked: boolean;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  /** the repository ignores it — shown greyed out */
  ignored: boolean;
}

export interface ClaudeStat {
  cwd: string;
  running: boolean;
  quiet_ms: number;
  burst_ms: number;
}

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** comma-separated globs; empty means every file */
  include: string;
  exclude: string;
}

export interface SearchSpan {
  /** offsets into `SearchLine.text`, in the units a JS string is indexed by */
  start: number;
  end: number;
  /** which match this is within its line — names one match to replace */
  nth: number;
}

export interface SearchLine {
  line: number;
  /** the line as shown: indentation dropped, long lines cut */
  text: string;
  spans: SearchSpan[];
}

export interface SearchFile {
  path: string;
  /** every match in the file, which can be more than `lines` lists */
  count: number;
  lines: SearchLine[];
}

export interface SearchResult {
  files: SearchFile[];
  matches: number;
  truncated: boolean;
}

/** a whole file when `line` is absent, one match when it isn't */
export interface ReplaceTarget {
  path: string;
  line?: number;
  nth?: number;
}

export const api = {
  claudeStatus: () => invoke<ClaudeStat[]>("claude_status"),
  getRecents: () => invoke<RecentProject[]>("get_recents"),
  addRecent: (path: string) => invoke<void>("add_recent", { path }),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  existingDirs: (paths: string[]) => invoke<string[]>("existing_dirs", { paths }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  resolvePaths: (cwd: string, paths: string[]) =>
    invoke<ResolvedPath[]>("resolve_paths", { cwd, paths }),
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
  gitBaseline: (path: string) => invoke<Baseline>("git_baseline", { path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  projectFiles: (root: string) => invoke<string[]>("list_project_files", { root }),
  searchProject: (root: string, query: SearchQuery) =>
    invoke<SearchResult>("search_project", { root, query }),
  replaceMatches: (root: string, query: SearchQuery, replacement: string, targets: ReplaceTarget[]) =>
    invoke<number>("replace_matches", { root, query, replacement, targets }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  /** raw bytes, for files that aren't text — arrives as an ArrayBuffer */
  readBinary: (path: string) => invoke<ArrayBuffer>("read_binary", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  ptyKillAll: () => invoke<void>("pty_kill_all"),
  ptySpawn: (id: string, cwd: string, cols: number, rows: number) =>
    invoke<void>("pty_spawn", { id, cwd, cols, rows }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
};

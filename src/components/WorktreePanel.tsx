import { useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api, FileChange } from "../lib/api";
import { FileIconSpan } from "./FileIcon";
import { Chevron } from "./Chevron";
import { pokeGit, useGitStatus, WorktreeChanges } from "../lib/gitStatus";
import type { Project } from "../App";
import type { View } from "./Workspace";

type WtState = WorktreeChanges;

const STATUS_CLASS: Record<string, string> = {
  M: "mod",
  A: "add",
  U: "add",
  D: "del",
  R: "mod",
};

export function WorktreePanel({
  project,
  onOpenView,
  active,
}: {
  project: Project;
  onOpenView: (v: View) => void;
  active: boolean;
}) {
  // the same sweep the file tree reads, so switching sidebar tabs doesn't cost
  // a fresh round of git processes — and so the two never disagree
  const git = useGitStatus(project.root, active);
  const worktrees = git.worktrees;
  const [failed, setFailed] = useState<string | null>(null);
  const error = failed ?? git.error;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ done: number; total: number } | null>(null);

  const toggleCollapsed = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const removeWt = async (wt: WtState) => {
    try {
      await api.worktreeRemove(project.root, wt.path, false);
    } catch (e) {
      const force = await confirm(
        `Worktree has uncommitted changes:\n${e}\n\nForce delete? Changes will be lost.`,
        { title: "Delete worktree", kind: "warning" }
      );
      if (!force) return;
      try {
        await api.worktreeRemove(project.root, wt.path, true);
      } catch (err) {
        setFailed(String(err));
        return;
      }
    }
    pokeGit();
  };

  const deletable = worktrees.filter((w) => !w.is_main);

  const removeAll = async () => {
    const ok = await confirm(
      `Delete all ${deletable.length} worktree${deletable.length === 1 ? "" : "s"}? Uncommitted changes will be lost.`,
      { title: "Delete all worktrees", kind: "warning" }
    );
    if (!ok) return;
    // one at a time — git serialises writes to the repo's worktree list
    // anyway — but with a running count, so a slow delete looks like work
    // rather than a hang
    for (let i = 0; i < deletable.length; i++) {
      setDeleting({ done: i, total: deletable.length });
      try {
        await api.worktreeRemove(project.root, deletable[i].path, true);
      } catch (e) {
        setFailed(String(e));
        setDeleting(null);
        return;
      }
    }
    setDeleting(null);
    pokeGit();
  };

  // every git action ends the same way: surface failures, then re-read state
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (e) {
      setNotice(String(e).split("\n").slice(0, 3).join(" "));
    } finally {
      setBusy(null);
      pokeGit();
    }
  };

  const stage = (wt: WtState, paths: string[]) => run(`stage:${wt.path}`, () => api.gitStage(wt.path, paths));
  const unstage = (wt: WtState, paths: string[]) =>
    run(`unstage:${wt.path}`, () => api.gitUnstage(wt.path, paths));

  const commit = async (wt: WtState, staged: FileChange[], unstaged: FileChange[]) => {
    const msg = (messages[wt.path] ?? "").trim();
    if (!msg) return;
    await run(
      `commit:${wt.path}`,
      async () => {
        // nothing staged: commit everything, the way ⌘↵ does in Cursor
        if (staged.length === 0) {
          await api.gitStage(wt.path, unstaged.map((c) => c.path));
        }
        await api.gitCommit(wt.path, msg);
        setMessages((m) => ({ ...m, [wt.path]: "" }));
      },
      "committed"
    );
  };

  if (error) return <div className="panel-error">not a git repo?<br />{error}</div>;

  const fileRow = (wt: WtState, c: FileChange, staged: boolean) => (
    <div key={`${wt.path}:${staged ? "s" : "w"}:${c.path}`} className="wt-file">
      <button
        className="wt-file-name"
        title={c.path}
        onClick={() =>
          // untracked files have no HEAD side — a diff would just be an
          // all-green copy of the file, so open the file itself like Cursor
          c.status === "U"
            ? onOpenView({
                kind: "file",
                key: `file:${wt.path}/${c.path}`,
                absPath: `${wt.path}/${c.path}`,
              })
            : onOpenView({
                kind: "diff",
                key: `diff:${wt.path}:${c.path}`,
                worktree: wt.path,
                relPath: c.path,
              })
        }
      >
        <FileIconSpan name={c.path.split("/").pop() ?? c.path} />
        <span className={`wt-file-base ${STATUS_CLASS[c.status] ?? "mod"}`}>{c.path.split("/").pop()}</span>
        <span className="wt-file-dir">{c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ""}</span>
      </button>
      <button
        className="wt-file-act"
        title={staged ? "unstage" : "stage"}
        onClick={() => (staged ? unstage(wt, [c.path]) : stage(wt, [c.path]))}
      >
        {staged ? "−" : "＋"}
      </button>
      <button
        className="wt-file-open"
        title="open file"
        onClick={() =>
          onOpenView({
            kind: "file",
            key: `file:${wt.path}/${c.path}`,
            absPath: `${wt.path}/${c.path}`,
          })
        }
      >
        ↗
      </button>
    </div>
  );

  return (
    <div className="wt-panel">
      {worktrees.map((wt) => {
        const staged = wt.changes.filter((c) => c.staged);
        const unstaged = wt.changes.filter((c) => !c.staged);
        const msg = messages[wt.path] ?? "";
        const open = !collapsed.has(wt.path);
        return (
          <div key={wt.path} className="wt-group">
            <div className="wt-header" title={wt.path} onClick={() => toggleCollapsed(wt.path)}>
              <Chevron open={open} className="wt-chevron" />
              <span className="wt-branch">{wt.branch || "(no branch)"}</span>
              <span className="wt-count">{wt.changes.length || ""}</span>
              {!wt.is_main && (
                <button
                  className="wt-delete"
                  title="delete worktree"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeWt(wt);
                  }}
                >
                  ✕
                </button>
              )}
            </div>

            {open && wt.changes.length > 0 && (
              <div className="wt-commit">
                <textarea
                  className="wt-msg"
                  rows={1}
                  placeholder={`message (⌘↵ to commit on ${wt.branch || "HEAD"})`}
                  value={msg}
                  onChange={(e) => setMessages((m) => ({ ...m, [wt.path]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      commit(wt, staged, unstaged);
                    }
                  }}
                />
                <button
                  className="wt-commit-btn"
                  disabled={!msg.trim() || busy === `commit:${wt.path}`}
                  onClick={() => commit(wt, staged, unstaged)}
                >
                  {staged.length > 0 ? `commit ${staged.length}` : "commit all"}
                </button>
              </div>
            )}

            {open && staged.length > 0 && (
              <>
                <div className="wt-section">
                  <span>staged</span>
                  <button title="unstage all" onClick={() => unstage(wt, staged.map((c) => c.path))}>
                    −
                  </button>
                </div>
                {staged.map((c) => fileRow(wt, c, true))}
              </>
            )}

            {open && unstaged.length > 0 && (
              <>
                {staged.length > 0 && (
                  <div className="wt-section">
                    <span>changes</span>
                    <button title="stage all" onClick={() => stage(wt, unstaged.map((c) => c.path))}>
                      ＋
                    </button>
                  </div>
                )}
                {unstaged.map((c) => fileRow(wt, c, false))}
              </>
            )}
          </div>
        );
      })}
      {notice && (
        <div className="wt-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {deletable.length > 0 && (
        <button
          className={`wt-delete-all ${deleting ? "busy" : ""}`}
          disabled={deleting !== null}
          title={`delete all ${deletable.length} worktrees`}
          onClick={removeAll}
        >
          {deleting ? `deleting ${deleting.done + 1}/${deleting.total}…` : "delete all"}
        </button>
      )}
    </div>
  );
}

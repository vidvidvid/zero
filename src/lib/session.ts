import { api } from "./api";
import type { Project } from "../App";
import type { TermNode } from "../components/Terminals";
import type { SidebarTab } from "../components/Sidebar";
import type { View } from "../components/Workspace";

/**
 * What the window looked like last time, so reopening zero puts it back.
 *
 * Layout only. The shells themselves are children of this process and die with
 * it — there is nothing to reattach to — so a restored pane is a *new* shell in
 * the same directory. Panes always run at the project root, so that part comes
 * back for free.
 *
 * localStorage rather than a file next to recents.json for one reason that
 * matters: it reads synchronously, so a restored project can be in the very
 * first render instead of arriving a frame later behind a flash of the
 * launcher.
 */

const KEY = "zero-session";

/** how long changes settle before hitting disk — dragging a divider fires per mousemove */
const WRITE_DELAY_MS = 150;

export interface ProjectSession {
  term: TermNode | null;
  focusedId: string | null;
  sidebarTab: SidebarTab;
  sidebarVisible: boolean;
  terminalVisible: boolean;
  views: View[];
  activeView: number;
}

interface Session {
  projects: Project[];
  activeIdx: number;
  byProject: Record<string, Partial<ProjectSession>>;
}

const empty = (): Session => ({ projects: [], activeIdx: 0, byProject: {} });

/* ---------- validation ----------
   Everything below treats the stored blob as untrusted: it survives across
   versions of zero, so a shape this build has never seen is normal, not
   exceptional. Anything unrecognised is dropped rather than defaulted, and a
   tree that can't be salvaged becomes null — which just means "fresh shell". */

function validTree(n: unknown, seen: Set<string>): TermNode | null {
  if (!n || typeof n !== "object") return null;
  const node = n as TermNode;

  if (node.type === "leaf") {
    // duplicate ids would collide as React keys and, worse, as pty ids
    if (typeof node.id !== "string" || !node.id || seen.has(node.id)) return null;
    seen.add(node.id);
    return { type: "leaf", id: node.id };
  }
  if (node.type !== "split") return null;
  if (node.dir !== "row" && node.dir !== "col") return null;
  if (!Array.isArray(node.children)) return null;

  const children = node.children
    .map((c) => validTree(c, seen))
    .filter((c): c is TermNode => c !== null);
  if (children.length === 0) return null;
  // a split that lost all but one child is just that child
  if (children.length === 1) return children[0];

  // sizes only survive if they still describe these children exactly; a
  // mismatch falls back to an even split rather than a guess
  const sizes =
    Array.isArray(node.sizes) &&
    node.sizes.length === children.length &&
    node.sizes.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0)
      ? node.sizes
      : undefined;
  return { type: "split", dir: node.dir, children, sizes };
}

/** Untitled buffers are deliberately not restorable: their contents live only
 *  in the editor, so a restored one would be an empty tab wearing its name. */
function validViews(v: unknown): View[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is View => {
    if (!x || typeof x !== "object") return false;
    const view = x as View;
    if (typeof view.key !== "string") return false;
    if (view.kind === "file") return typeof view.absPath === "string";
    if (view.kind === "diff")
      return typeof view.worktree === "string" && typeof view.relPath === "string";
    return false;
  });
}

function validProjectSession(v: unknown): Partial<ProjectSession> {
  if (!v || typeof v !== "object") return {};
  const p = v as Partial<ProjectSession>;
  const views = validViews(p.views);
  return {
    term: validTree(p.term, new Set()),
    focusedId: typeof p.focusedId === "string" ? p.focusedId : null,
    sidebarTab: p.sidebarTab === "files" || p.sidebarTab === "scm" ? p.sidebarTab : undefined,
    sidebarVisible: typeof p.sidebarVisible === "boolean" ? p.sidebarVisible : undefined,
    terminalVisible: typeof p.terminalVisible === "boolean" ? p.terminalVisible : undefined,
    views,
    // dropped untitled tabs can leave the index past the end
    activeView:
      typeof p.activeView === "number" ? Math.min(Math.max(p.activeView, 0), views.length - 1) : 0,
  };
}

function parse(raw: string | null): Session {
  if (!raw) return empty();
  let blob: Partial<Session>;
  try {
    blob = JSON.parse(raw) as Partial<Session>;
  } catch {
    return empty();
  }

  const seenRoots = new Set<string>();
  const projects = (Array.isArray(blob.projects) ? blob.projects : []).filter(
    (p): p is Project =>
      !!p &&
      typeof p.root === "string" &&
      !!p.root &&
      typeof p.name === "string" &&
      !seenRoots.has(p.root) &&
      !!seenRoots.add(p.root)
  );

  const byProject: Session["byProject"] = {};
  for (const p of projects) {
    byProject[p.root] = validProjectSession((blob.byProject ?? {})[p.root]);
  }

  const activeIdx =
    typeof blob.activeIdx === "number" && blob.activeIdx >= 0 && blob.activeIdx < projects.length
      ? blob.activeIdx
      : 0;

  return { projects, activeIdx, byProject };
}

/* ---------- the live copy ---------- */

// One in-memory object that App and every Workspace patch independently, so
// their writes merge instead of racing through a read-modify-write each.
let current: Session = empty();
let timer: number | undefined;

function flush() {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // a full or disabled store costs you the layout, nothing else
  }
}

function schedule() {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(flush, WRITE_DELAY_MS);
}

// closing the window shouldn't cost you the last 150 ms of changes
window.addEventListener("beforeunload", flush);

/**
 * Read the stored session and drop any project that has since moved or been
 * deleted. Async only because of that existence check — everything the first
 * render needs is already parsed by the time it resolves.
 */
export async function restoreSession(): Promise<{ projects: Project[]; activeIdx: number }> {
  current = parse(localStorage.getItem(KEY));
  if (current.projects.length === 0) return { projects: [], activeIdx: 0 };

  const roots = current.projects.map((p) => p.root);
  let alive: string[];
  try {
    alive = await api.existingDirs(roots);
  } catch {
    alive = roots; // can't check: better a stale tab than an empty window
  }

  const live = new Set(alive);
  const activeRoot = current.projects[current.activeIdx]?.root;
  current.projects = current.projects.filter((p) => live.has(p.root));
  for (const root of Object.keys(current.byProject)) {
    if (!live.has(root)) delete current.byProject[root];
  }
  // keep whichever project was in front, unless it's one of the ones that went
  const idx = current.projects.findIndex((p) => p.root === activeRoot);
  current.activeIdx = idx >= 0 ? idx : 0;

  return { projects: current.projects, activeIdx: current.activeIdx };
}

/** Read once, at mount. Workspaces are keyed by root, so this never goes stale. */
export function projectSession(root: string): Partial<ProjectSession> {
  return current.byProject[root] ?? {};
}

export function saveProjects(projects: Project[], activeIdx: number) {
  current.projects = projects;
  current.activeIdx = activeIdx;
  // a closed project takes its layout with it
  const live = new Set(projects.map((p) => p.root));
  for (const root of Object.keys(current.byProject)) {
    if (!live.has(root)) delete current.byProject[root];
  }
  schedule();
}

export function saveProject(root: string, state: Partial<ProjectSession>) {
  current.byProject[root] = { ...current.byProject[root], ...state };
  schedule();
}

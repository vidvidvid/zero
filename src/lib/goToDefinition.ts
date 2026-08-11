import { api } from "./api";

/**
 * ⌘-click a name in the editor and land on where it's defined.
 *
 * Names, not symbols. A language server resolves an identifier through the
 * type graph; this reads the file's own import statements and follows the one
 * that binds the name you clicked. That covers imported components — the case
 * this exists for — and same-file definitions, and knows it covers nothing
 * else: a name re-exported through a barrel lands on the barrel, and a name
 * with no import and no local definition doesn't resolve at all.
 *
 * The alternative is a TypeScript language server, which is a long-running
 * process and tens of megabytes.
 */

/** in preference order — the first of these that exists on disk wins */
const SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".css"];
const INDEXES = ["/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

export interface Definition {
  abs: string;
  /** 1-based, absent when the file resolved but the name didn't */
  line?: number;
}

export interface Token {
  text: string;
  isSpecifier: boolean;
  /** document offsets of the text itself, quotes excluded */
  from: number;
  to: number;
}

/** the identifier or module string under a document offset */
export function tokenAt(doc: string, pos: number): Token | null {
  // inside a quoted string? then it's a module specifier, quotes and all
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = doc.indexOf("\n", pos);
  if (lineEnd < 0) lineEnd = doc.length;
  const line = doc.slice(lineStart, lineEnd);
  const col = pos - lineStart;

  for (const m of line.matchAll(/["'`]([^"'`]*)["'`]/g)) {
    const start = m.index ?? 0;
    if (col > start && col < start + m[0].length) {
      if (!m[1]) return null;
      const from = lineStart + start + 1;
      return { text: m[1], isSpecifier: true, from, to: from + m[1].length };
    }
  }

  const ident = /[A-Za-z_$][\w$]*/g;
  for (const m of line.matchAll(ident)) {
    const start = m.index ?? 0;
    if (col >= start && col <= start + m[0].length) {
      const from = lineStart + start;
      return { text: m[0], isSpecifier: false, from, to: from + m[0].length };
    }
  }
  return null;
}

/**
 * The module an import statement binds `name` from.
 *
 * Handles the four shapes that bind a name: default, namespace, named, and
 * named-with-alias. The alias is what's in scope, so `{ a as b }` is a match
 * for `b` and not for `a`.
 */
export function importSpecifierFor(doc: string, name: string): string | null {
  const imports = /import\s+([^;]*?)\s+from\s*["']([^"']+)["']/g;
  for (const m of doc.matchAll(imports)) {
    const clause = m[1];
    const from = m[2];
    // `import type { X }` binds X just the same for our purposes
    const body = clause.replace(/^type\s+/, "");

    const braces = /\{([^}]*)\}/.exec(body);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const bits = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        const bound = (bits[1] ?? bits[0]).trim();
        if (bound === name) return from;
      }
    }
    // whatever sits outside the braces: `X`, `* as X`, or `X, { … }`
    const outside = body.replace(/\{[^}]*\}/, "").replace(/,/g, " ");
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(outside);
    if (ns && ns[1] === name) return from;
    for (const word of outside.split(/\s+/)) {
      if (word && word !== "*" && word !== "as" && word === name) return from;
    }
  }
  return null;
}

/** every path worth trying for one specifier, best first */
export function candidatesFor(spec: string): string[] {
  const out: string[] = [];
  for (const s of SUFFIXES) out.push(spec + s);
  for (const i of INDEXES) out.push(spec + i);
  // `./Foo.js` in TypeScript source usually means `./Foo.ts`
  const swapped = spec.replace(/\.(m|c)?js$/, "");
  if (swapped !== spec) for (const s of SUFFIXES) out.push(swapped + s);
  return out;
}

/**
 * The 1-based line where `name` is defined, or undefined.
 *
 * Regex, not a parser: when the shape is unfamiliar this returns nothing and
 * the file opens at the top, which is a worse answer than a language server's
 * and a much better one than a confidently wrong line.
 */
export function definitionLine(source: string, name: string): number | undefined {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    // `export default function Foo`, `export const Foo =`, `export class Foo`
    new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${n}\\b`),
    new RegExp(`^\\s*(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${n}\\b`),
    // `export default memo(function Foo(` and friends
    new RegExp(`^\\s*export\\s+default\\s+.*\\bfunction\\s+${n}\\b`),
    // a bare re-export naming it: not a definition, but the right file to land in
    new RegExp(`^\\s*export\\s*\\{[^}]*\\b${n}\\b`),
  ];
  const lines = source.split("\n");
  for (const re of patterns) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return i + 1;
  }
  return undefined;
}

const dirOf = (abs: string) => abs.slice(0, abs.lastIndexOf("/")) || "/";

/**
 * Whether this token is worth lighting up under ⌘, decided without touching
 * the disk — a hover affordance that arrived a round trip late would trail the
 * pointer. A name the file imports is as good as resolvable; whether the file
 * on the other end exists is the click's problem.
 */
export function looksResolvable(doc: string, token: Token): boolean {
  if (token.isSpecifier) return true;
  return !!importSpecifierFor(doc, token.text) || !!definitionLine(doc, token.text);
}

/* ---------- tsconfig path aliases ----------
   `@/components/ui/table` is the shape most projects import their own code by,
   and it isn't a package. Resolving it means the same lookup TypeScript does:
   the nearest tsconfig's `paths`, rooted at its `baseUrl`. */

/**
 * Nearest first — resolve_paths returns hits in the order asked.
 *
 * Generous on depth because app-router trees get deep: a route like
 * `src/app/(admin)/admin/rounds/[roundId]/staging-import/page.tsx` is already
 * seven levels down, and coming up short means silently finding no aliases at
 * all. Thirty-odd candidates still cost one call.
 */
function configCandidates(): string[] {
  const out: string[] = [];
  let up = "";
  for (let i = 0; i < 16; i++) {
    out.push(`${up}tsconfig.json`, `${up}jsconfig.json`);
    up += "../";
  }
  return out;
}

/** tsconfig is JSON with comments, and often a trailing comma */
function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const stripped = text
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) =>
        m.startsWith('"') ? m : ""
      )
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

interface Aliases {
  /** what `paths` targets are relative to */
  baseDir: string;
  paths: Record<string, string[]>;
}

const configCache = new Map<string, Aliases | null>();

async function readAliases(abs: string, depth = 0): Promise<Aliases | null> {
  const text = await api.readFile(abs).catch(() => null);
  const json = text ? parseJsonc(text) : null;
  if (!json) return null;

  const opts = (json.compilerOptions ?? {}) as Record<string, unknown>;
  const paths = opts.paths as Record<string, string[]> | undefined;
  const here = dirOf(abs);

  if (paths && Object.keys(paths).length) {
    const baseUrl = typeof opts.baseUrl === "string" ? opts.baseUrl : ".";
    return { baseDir: `${here}/${baseUrl}`, paths };
  }
  // monorepos keep them in a shared base config
  const extend = json.extends;
  if (typeof extend === "string" && extend.startsWith(".") && depth < 3) {
    const hits = await api.resolvePaths(here, candidatesFor(extend)).catch(() => []);
    if (hits[0]) return await readAliases(hits[0].abs, depth + 1);
  }
  return null;
}

async function aliasesFor(dir: string): Promise<Aliases | null> {
  const cached = configCache.get(dir);
  if (cached !== undefined) return cached;
  const hits = await api.resolvePaths(dir, configCandidates()).catch(() => []);
  const found = hits[0] ? await readAliases(hits[0].abs) : null;
  configCache.set(dir, found);
  return found;
}

/** every file a bare specifier could mean, going through `paths` */
export function expandAlias(spec: string, aliases: Aliases): string[] {
  const out: string[] = [];
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const star = pattern.indexOf("*");
    let middle = "";
    if (star < 0) {
      if (pattern !== spec) continue;
    } else {
      const head = pattern.slice(0, star);
      const tail = pattern.slice(star + 1);
      if (!spec.startsWith(head) || !spec.endsWith(tail)) continue;
      if (spec.length < head.length + tail.length) continue;
      middle = spec.slice(head.length, spec.length - tail.length);
    }
    for (const target of targets) {
      const filled = target.includes("*") ? target.replace("*", middle) : target;
      // left unnormalised on purpose — the `.` and `..` are canonicalised on
      // the Rust side, which is the only place that can do it truthfully
      out.push(...candidatesFor(`${aliases.baseDir}/${filled}`));
    }
  }
  return out;
}

async function aliasCandidates(dir: string, spec: string): Promise<string[]> {
  const aliases = await aliasesFor(dir);
  return aliases ? expandAlias(spec, aliases) : [];
}

/**
 * @param doc     the file being read, for its imports
 * @param absPath that file, for resolving relative specifiers
 */
export async function findDefinition(
  doc: string,
  absPath: string,
  token: Token
): Promise<Definition | null> {
  const dir = dirOf(absPath);

  // a name defined right here needs no resolving at all
  if (!token.isSpecifier) {
    const local = definitionLine(doc, token.text);
    const spec = importSpecifierFor(doc, token.text);
    if (local && !spec) return { abs: absPath, line: local };
    if (!spec) return null;
    return await follow(dir, spec, token.text);
  }
  return await follow(dir, token.text, null);
}

async function follow(dir: string, spec: string, name: string | null): Promise<Definition | null> {
  const relative = spec.startsWith(".") || spec.startsWith("/");
  // A bare specifier is either a tsconfig alias — `@/components/ui/table` —
  // or a real package. Aliases are worth following; packages are not, since
  // what you'd land in is a .d.ts in node_modules.
  const paths = relative ? candidatesFor(spec) : await aliasCandidates(dir, spec);
  if (!paths.length) return null;

  const hits = await api.resolvePaths(dir, paths).catch(() => []);
  const abs = hits[0]?.abs;
  if (!abs) return null;
  if (!name) return { abs };

  const source = await api.readFile(abs).catch(() => null);
  return { abs, line: source ? definitionLine(source, name) : undefined };
}

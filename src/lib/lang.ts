import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

/**
 * Highlighting comes in two waves.
 *
 * The languages zero is itself written in are bundled and applied the instant
 * the editor exists, because those are the files you open all day and a tab
 * that lands grey and colours in a frame later is a flicker you'd notice.
 * Everything else — the other hundred and thirty-odd — is fetched only when a
 * file of that kind is actually opened, so a project with no Ruby in it never
 * pays for the Ruby mode.
 *
 * A script named without an extension gets a third chance: its shebang line
 * names an interpreter, and the interpreter names the mode.
 */
export function langFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "py":
    case "pyi":
      return [python()];
    case "css":
      return [css()];
    case "html":
    case "htm":
    // no Svelte mode exists to load, and its markup half is plain HTML
    case "svelte":
      return [html()];
    case "json":
      return [json()];
    case "md":
    case "markdown":
      // fenced code blocks colour as their own language, fetched from the
      // registry only when a fence actually names one
      return [markdown({ codeLanguages: languages })];
    case "rs":
      return [rust()];
    default:
      return [];
  }
}

/**
 * Extensions language-data doesn't recognise, mapped to the mode a person
 * would expect. Keys are lowercased extensions, or whole filenames when the
 * name is the whole signal.
 */
const ALIASES: Record<string, string> = {
  zsh: "Shell",
  zshrc: "Shell",
  bashrc: "Shell",
  fish: "Shell",
  ksh: "Shell",
  ".bashrc": "Shell",
  ".zshrc": "Shell",
  ".profile": "Shell",
  ".bash_profile": "Shell",
  ".zprofile": "Shell",
  ".env": "Properties files",
  // .m is Mathematica by language-data's reckoning and Objective-C by
  // everyone else's
  m: "Objective-C",
  mdx: "Markdown",
  mkd: "Markdown",
  jsonc: "JSON",
  json5: "JSON",
  webmanifest: "JSON",
  ".babelrc": "JSON",
  ".eslintrc": "JSON",
  ".prettierrc": "JSON",
  bzl: "Python",
  // no Elixir mode exists to load; Ruby is the close cousin that does
  ex: "Ruby",
  exs: "Ruby",
  ".gitmodules": "Properties files",
  // ignore files are comments and patterns, which is most of what the
  // properties mode colours anyway
  ".gitignore": "Properties files",
  ".gitattributes": "Properties files",
  ".dockerignore": "Properties files",
  ".npmignore": "Properties files",
  ".editorconfig": "Properties files",
  ".npmrc": "Properties files",
  ".gitconfig": "Properties files",
  cfg: "Properties files",
  plist: "XML",
  xsd: "XML",
  xslt: "XML",
  storyboard: "XML",
  podspec: "Ruby",
  gemspec: "Ruby",
  brewfile: "Ruby",
  ino: "C++",
  ipp: "C++",
  metal: "C++",
};

/**
 * The mode for a file zero doesn't bundle, or null when `langFor` already
 * covered it and when nothing matches at all. Resolving it means fetching a
 * chunk, so it lands a moment after the text does.
 */
export async function lazyLangFor(path: string): Promise<Extension[] | null> {
  const name = path.split("/").pop() ?? path;
  if (langFor(name).length) return null;

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const alias = ALIASES[name] ?? ALIASES[name.toLowerCase()] ?? ALIASES[ext];
  let desc = alias
    ? LanguageDescription.matchLanguageName(languages, alias)
    : LanguageDescription.matchFilename(languages, name);
  // families named by prefix rather than extension: Dockerfile.dev,
  // .env.production
  if (!desc) {
    const lower = name.toLowerCase();
    if (lower.startsWith("dockerfile")) {
      desc = LanguageDescription.matchLanguageName(languages, "Dockerfile");
    } else if (lower.startsWith(".env.")) {
      desc = LanguageDescription.matchLanguageName(languages, "Properties files");
    }
  }
  return desc ? loadMode(desc) : null;
}

/**
 * Interpreters a shebang can name, keyed after version numbers are stripped —
 * python3.12 looks up as python.
 */
const INTERPRETERS: Record<string, string> = {
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  dash: "Shell",
  ksh: "Shell",
  fish: "Shell",
  python: "Python",
  node: "JavaScript",
  bun: "JavaScript",
  deno: "JavaScript",
  ruby: "Ruby",
  perl: "Perl",
  php: "PHP",
  lua: "Lua",
};

/**
 * The mode for a script whose first line says what it is — `deploy` opening
 * with `#!/bin/bash`. Only worth consulting when the name said nothing.
 */
export async function lazyLangForShebang(content: string): Promise<Extension[] | null> {
  if (!content.startsWith("#!")) return null;
  const nl = content.indexOf("\n");
  const words = content
    .slice(2, nl === -1 ? undefined : nl)
    .trim()
    .split(/\s+/);
  // `#!/usr/bin/env -S python3 -u` — the interpreter is the first word after
  // env that isn't a flag
  let interp = words[0]?.split("/").pop() ?? "";
  if (interp === "env") interp = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
  interp = (interp.split("/").pop() ?? "").toLowerCase().replace(/[\d.]+$/, "");
  const lang = INTERPRETERS[interp];
  const desc = lang ? LanguageDescription.matchLanguageName(languages, lang) : null;
  return desc ? loadMode(desc) : null;
}

async function loadMode(desc: LanguageDescription): Promise<Extension[] | null> {
  try {
    return [await desc.load()];
  } catch {
    // a chunk that won't load leaves the file plain, which is what it was
    return null;
  }
}

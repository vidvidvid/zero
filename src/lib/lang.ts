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
      return [markdown()];
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
  ".gitmodules": "Properties files",
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
  const desc = alias
    ? LanguageDescription.matchLanguageName(languages, alias)
    : LanguageDescription.matchFilename(languages, name);
  if (!desc) return null;

  try {
    return [await desc.load()];
  } catch {
    // a chunk that won't load leaves the file plain, which is what it was
    return null;
  }
}

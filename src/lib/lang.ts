import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import type { Extension } from "@codemirror/state";

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
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "py":
      return [python()];
    case "css":
    case "scss":
      return [css()];
    case "html":
    case "htm":
    case "svelte":
    case "vue":
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

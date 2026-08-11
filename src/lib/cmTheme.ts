import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { constNames } from "./constNames";

// VS Code / Cursor "Dark Modern" (Dark+) — editor chrome
const darkModernChrome = EditorView.theme(
  {
    "&": {
      backgroundColor: "#1f1f1f",
      color: "#cccccc",
    },
    ".cm-content": {
      caretColor: "#aeafad",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#aeafad",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection": {
      backgroundColor: "#264f78",
    },
    ".cm-selectionBackground": {
      backgroundColor: "#264f7855",
    },
    ".cm-activeLine": {
      backgroundColor: "#ffffff08",
    },
    ".cm-gutters": {
      backgroundColor: "#1f1f1f",
      color: "#6e7681",
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#cccccc",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "3.2ch",
    },
    ".cm-matchingBracket": {
      backgroundColor: "#0064961a",
      outline: "1px solid #888888aa",
    },
    ".cm-searchMatch": {
      backgroundColor: "#613214",
      outline: "1px solid #74572f",
    },
    ".cm-selectionMatch": {
      backgroundColor: "#343a41",
    },
  },
  { dark: true }
);

// Dark+ token colors
const darkModernHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.bool, t.null, t.atom, t.self], color: "#569cd6" },
  {
    tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
    color: "#c586c0",
  },
  { tag: [t.string, t.special(t.string), t.character], color: "#ce9178" },
  { tag: [t.number, t.integer, t.float], color: "#b5cea8" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "#6a9955" },
  // `t.function(t.definition(...))` is what a *declaration* gets — without it
  // the name in `export function useThing()` falls back to the plain-variable
  // rule below and comes out light blue instead of yellow
  {
    tag: [
      t.function(t.variableName),
      t.function(t.definition(t.variableName)),
      t.function(t.propertyName),
      t.macroName,
    ],
    color: "#dcdcaa",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "#4ec9b0" },
  { tag: [t.variableName, t.propertyName, t.definition(t.variableName), t.attributeName], color: "#9cdcfe" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "#4fc1ff" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#d4d4d4" },
  { tag: [t.regexp], color: "#d16969" },
  { tag: [t.escape, t.special(t.character)], color: "#d7ba7d" },
  // JSX splits two ways: lowercase `<div>` is a built-in and stays blue, while
  // `<Table>` is a component and takes the type colour, as it does in Cursor
  { tag: [t.standard(t.tagName)], color: "#569cd6" },
  { tag: [t.tagName], color: "#4ec9b0" },
  { tag: [t.angleBracket], color: "#808080" },
  { tag: [t.heading], color: "#569cd6", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#3794ff" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.meta, t.processingInstruction], color: "#808080" },
  { tag: [t.invalid], color: "#f44747" },
]);

export const darkModern = [darkModernChrome, syntaxHighlighting(darkModernHighlight), constNames];

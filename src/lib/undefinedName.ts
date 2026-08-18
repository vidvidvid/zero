import { language, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * `undefined`, coloured like the literal it is.
 *
 * Lezer has no node for it — the grammar keys `null`, `true` and `false` off
 * their own tokens, but `undefined` is an ordinary global, so it parses as a
 * plain `VariableName` and comes out the same light blue as `count` or `path`.
 * Cursor doesn't do it that way: its TextMate grammar matches the word
 * outright as `constant.language.undefined`, which is the same scope `null`
 * gets, so the two read as the pair they are. This restores that by finding
 * the name in the tree; each theme then paints `.cm-undefined` with whatever
 * it already paints `null`.
 *
 * Only in value position. `foo.undefined` is a property and `x: undefined` is
 * a type, and Cursor leaves both alone — the grammar's match is guarded
 * against a leading dot, and the type rule fires first.
 */

const undefinedMark = Decoration.mark({ class: "cm-undefined" });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // A name is only special in the language that has the global. The facet
  // reads the outermost language, so JS embedded in HTML goes uncoloured
  // rather than risking a Python variable that happens to share the word.
  // Two names cover the four dialects: jsx reports as javascript and tsx as
  // typescript, because lang-javascript configures rather than redefines.
  const lang = view.state.facet(language)?.name;
  if (lang !== "javascript" && lang !== "typescript") return builder.finish();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "VariableName") return;
        if (view.state.doc.sliceString(node.from, node.to) !== "undefined") return;
        builder.add(node.from, node.to, undefinedMark);
      },
    });
  }
  return builder.finish();
}

export const undefinedNames = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

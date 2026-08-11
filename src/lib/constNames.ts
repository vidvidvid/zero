import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * What `const` declares, coloured the way Cursor colours it.
 *
 * Cursor gets this from the type checker: TypeScript reports a `const` as a
 * variable with the `readonly` modifier, which Dark Modern maps through
 * `variable.other.constant` to #4fc1ff. Lezer has no tag for it, because the
 * distinction lives in the declaration keyword rather than in the name — so
 * this reads the keyword off the tree instead.
 *
 * The initializer is worth looking at too. `const Foo = () => {}` is a
 * function to every reader and to Cursor's classifier, so it takes the
 * function colour rather than the constant one — which also settles the
 * arrow-function case that plain tag-based highlighting always gets wrong.
 */

const constName = Decoration.mark({ class: "cm-const-name" });
const fnName = Decoration.mark({ class: "cm-fn-name" });

/** the value a definition is initialised to, skipping `= ` and any type annotation */
function initializerOf(def: { nextSibling: SyntaxNodeLike | null }): string | null {
  for (let n = def.nextSibling; n; n = n.nextSibling) {
    if (n.name === "Equals" || n.name === "TypeAnnotation") continue;
    return n.name;
  }
  return null;
}

interface SyntaxNodeLike {
  name: string;
  from: number;
  to: number;
  firstChild: SyntaxNodeLike | null;
  nextSibling: SyntaxNodeLike | null;
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "VariableDeclaration") return;
        const decl = node.node as unknown as SyntaxNodeLike;
        // `const` / `let` / `var` is the first child; only the first is ours
        const kw = decl.firstChild;
        if (!kw || view.state.doc.sliceString(kw.from, kw.to) !== "const") return;
        for (let c = decl.firstChild; c; c = c.nextSibling) {
          if (c.name !== "VariableDefinition") continue;
          const init = initializerOf(c);
          const isFn = init === "ArrowFunction" || init === "FunctionExpression";
          builder.add(c.from, c.to, isFn ? fnName : constName);
        }
      },
    });
  }
  return builder.finish();
}

export const constNames = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      // the tree changes identity as parsing catches up on a big file, which
      // is its own reason to rebuild even when nothing else moved
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

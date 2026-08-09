import seti from "./setiIcons.json";

interface IconDef {
  ch: string;
  color: string;
}

interface SetiMap {
  byName: Record<string, IconDef>;
  byExt: Record<string, IconDef>;
  file: IconDef;
}

const map = seti as SetiMap;

// "\E099" (CSS-style escape from the VS Code theme) -> actual glyph
function glyph(def: IconDef): IconDef {
  return { ch: String.fromCharCode(parseInt(def.ch.slice(1), 16)), color: def.color };
}

export function fileIcon(name: string): IconDef {
  const lower = name.toLowerCase();
  const exact = map.byName[lower];
  if (exact) return glyph(exact);
  // longest-suffix match so "foo.d.ts" prefers "d.ts" over "ts"
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const hit = map.byExt[ext];
    if (hit) return glyph(hit);
  }
  return glyph(map.file);
}

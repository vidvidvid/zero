import type { ReactNode } from "react";

/**
 * Enough Markdown to read a memo by, and not one construct more.
 *
 * A memo document is written by one prompt for one purpose: a `# ` title, some
 * paragraphs, some bullets, the occasional bold. So this renders exactly that —
 * three heading levels, both kinds of list with one level of nesting, bold,
 * italic, inline code, blockquotes, rules and paragraphs — and lets everything
 * else fall through as the text it is. A pipeline table stays a line of pipes,
 * a code fence stays three backticks, a link stays `[text](url)`, and none of
 * them is wrong on screen so much as plain.
 *
 * What it deliberately doesn't do is the reason it exists at all: this codebase
 * has no markdown dependency, and adding one to draw six tags would be the
 * largest thing in the app by weight. It also never touches `innerHTML` — every
 * node here is a React element with text children, so the escaping isn't a step
 * that could be forgotten, it's the only thing that can happen.
 */

/** `**bold**`, `*italic*`, `` `code` `` — split on, so the text between the
 *  matches survives as itself. The double-star alternative comes first, or
 *  `**a**` is read as an italic `*a*` wearing extra stars. */
const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

const HEADING = /^(#{1,3})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;

function inline(text: string): ReactNode[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .map((part, i) => {
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
        return <code key={i}>{part.slice(1, -1)}</code>;
      if (part.length > 2 && part.startsWith("*") && part.endsWith("*"))
        return <em key={i}>{part.slice(1, -1)}</em>;
      return part;
    });
}

/** `- a`, `* a`, `1. a` — how deep it is, which kind it is, and what it says.
 *  Two spaces is a nesting level; the exact number people type varies and the
 *  distinction between two and four isn't one a memo ever means. */
function item(line: string) {
  const bullet = BULLET.exec(line);
  const m = bullet ?? NUMBER.exec(line);
  if (!m) return null;
  return { deep: m[1].length >= 2, ordered: !bullet, text: m[2] };
}

const opensSomethingElse = (line: string) =>
  HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || item(line) !== null;

/** One list, from `from` to wherever it stops, and the line it stopped on.
 *  Indented items belong to the item above them; a second level of indent is
 *  folded into the first, because a memo that needs three is a document. */
function list(lines: string[], from: number, key: number): [ReactNode, number] {
  const top = item(lines[from])!;
  const rows: { text: string; kids: string[] }[] = [];
  let i = from;
  while (i < lines.length) {
    const it = item(lines[i]);
    if (!it) break;
    if (it.deep && rows.length) rows[rows.length - 1].kids.push(it.text);
    // the other kind of list starting at this level is a new list, not a row
    else if (it.ordered !== top.ordered) break;
    else rows.push({ text: it.text, kids: [] });
    i++;
  }
  const Tag = top.ordered ? "ol" : "ul";
  return [
    <Tag key={key}>
      {rows.map((row, n) => (
        <li key={n}>
          {inline(row.text)}
          {/* a nested list is drawn as a list; which kind it was is a
              distinction one level down doesn't earn */}
          {row.kids.length > 0 && (
            <ul>
              {row.kids.map((kid, j) => (
                <li key={j}>{inline(kid)}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </Tag>,
    i,
  ];
}

/** The blocks of one document, ready to drop into a container. */
export function miniMarkdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = (["h1", "h2", "h3"] as const)[heading[1].length - 1];
      out.push(<Tag key={out.length}>{inline(heading[2].trim())}</Tag>);
      i++;
    } else if (RULE.test(line)) {
      out.push(<hr key={out.length} />);
      i++;
    } else if (QUOTE.test(line)) {
      const said: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i]);
        if (!quoted) break;
        said.push(quoted[1]);
        i++;
      }
      out.push(<blockquote key={out.length}>{inline(said.join(" "))}</blockquote>);
    } else if (item(line)) {
      const [node, next] = list(lines, i, out.length);
      out.push(node);
      i = next;
    } else {
      // a paragraph runs to the next blank line, or to the next line that is
      // the start of something — which is what makes an unfenced anything
      // degrade into readable prose rather than swallow the rest of the memo
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !opensSomethingElse(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      out.push(<p key={out.length}>{inline(para.join(" "))}</p>);
    }
  }
  return out;
}

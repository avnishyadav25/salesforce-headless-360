/**
 * A small Markdown parser for the chat and the meeting brief. It returns a plain tree that
 * components/Markdown.tsx turns into React elements, so no HTML string is ever injected and
 * text from Salesforce records can't add markup. Supported: headings (#..####), paragraphs,
 * bullet and numbered lists, pipe tables, fenced code, and inline **bold**, *italic*, `code`
 * and [links](https://...) (http, https and mailto only).
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "br" };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] }
  | { type: "code"; text: string };

const SAFE_LINK = /^(https?:|mailto:)/i;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    let m: RegExpMatchArray | null;
    if (rest.startsWith("\n")) {
      flush();
      out.push({ type: "br" });
      i += 1;
    } else if ((m = rest.match(/^`([^`\n]+)`/))) {
      flush();
      out.push({ type: "code", text: m[1]! });
      i += m[0].length;
    } else if ((m = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/))) {
      flush();
      out.push({ type: "strong", children: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = rest.match(/^\*(?=[^\s*])([^*\n]*?[^\s*])\*/)) || (m = rest.match(/^_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9])/))) {
      flush();
      out.push({ type: "em", children: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/)) && SAFE_LINK.test(m[2]!)) {
      flush();
      out.push({ type: "link", href: m[2]!, children: parseInline(m[1]!) });
      i += m[0].length;
    } else {
      text += source[i];
      i += 1;
    }
  }
  flush();
  return out;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = line.match(/^\s*```/);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1; // closing fence (or end of text while streaming)
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4, children: parseInline(heading[2]!.trim()) });
      i += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const header = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(cells(lines[i++]!).map(parseInline));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const listKind = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (listKind) {
      const items: Inline[][] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(listKind);
        if (item) {
          items.push(parseInline(item[1]!));
        } else if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length) {
          items[items.length - 1]!.push({ type: "br" }, ...parseInline(lines[i]!.trim())); // continuation line
        } else {
          break;
        }
        i += 1;
      }
      blocks.push({ type: "list", ordered: listKind === NUMBERED, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*```/.test(lines[i]!) &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !BULLET.test(lines[i]!) &&
      !NUMBERED.test(lines[i]!) &&
      !(TABLE_ROW.test(lines[i]!) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!))
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}

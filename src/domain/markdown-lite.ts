/**
 * Minimal, deterministic Markdown-subset parser — not a general Markdown
 * implementation. Exists solely to render the Itinerary Writer agent's
 * (`src/agents/itinerary-writer.ts`) prose output, which is unconstrained
 * free text (its system prompt asks for "a well-organized, welcoming
 * write-up" with no formatting spec) but observed in practice to use plain
 * paragraphs, `**bold**`/`*italic*` emphasis, and occasional bullet/numbered
 * lists — the same bounded style any LLM defaults to for "organized prose."
 * A full CommonMark parser is unwarranted for that: this project keeps
 * runtime dependencies minimal (`package.json` — 7 total, all load-bearing
 * SDKs/framework), and the input is model output, not arbitrary user
 * Markdown, so unsupported syntax degrading to plain text is an acceptable
 * trade-off rather than a gap to close by pulling in a Markdown library.
 */

export type InlineSegment =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; inline: InlineSegment[] }
  | { type: "paragraph"; inline: InlineSegment[] }
  | { type: "list"; ordered: boolean; items: InlineSegment[][] };

const INLINE_PATTERN = /\*\*(.+?)\*\*|\*(.+?)\*/g;

/** `**bold**` and `*italic*` only — the two emphasis forms actually observed in Writer output. */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    if (index > lastIndex) segments.push({ type: "text", text: text.slice(lastIndex, index) });
    if (match[1] !== undefined) segments.push({ type: "bold", text: match[1] });
    else if (match[2] !== undefined) segments.push({ type: "italic", text: match[2] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ type: "text", text: text.slice(lastIndex) });
  return segments;
}

const HEADING_LINE = /^(#{1,3})\s+(.*)$/;
const BULLET_LINE = /^[-*]\s+(.*)$/;
const ORDERED_LINE = /^\d+\.\s+(.*)$/;

/**
 * Blank lines separate paragraphs/lists; consecutive non-blank plain lines
 * join into one paragraph (a single space between them) rather than
 * preserving each as its own line, since the Writer's own line-wrapping
 * (if any) isn't meaningful — only its blank-line paragraph breaks are.
 */
export function parseMarkdownLite(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    blocks.push({ type: "paragraph", inline: parseInline(paragraphLines.join(" ")) });
    paragraphLines = [];
  }
  function flushList() {
    if (listItems.length === 0) return;
    blocks.push({ type: "list", ordered: listOrdered, items: listItems.map(parseInline) });
    listItems = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, inline: parseInline(heading[2]) });
      continue;
    }

    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      flushParagraph();
      if (listItems.length > 0 && listOrdered) flushList();
      listOrdered = false;
      listItems.push(bullet[1]);
      continue;
    }

    const ordered = ORDERED_LINE.exec(line);
    if (ordered) {
      flushParagraph();
      if (listItems.length > 0 && !listOrdered) flushList();
      listOrdered = true;
      listItems.push(ordered[1]);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

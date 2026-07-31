/**
 * Minimal markdown tokenizer for AI agent prose (DO-313).
 *
 * String in, a typed MdBlock[] union out. The union deliberately has NO `html`
 * kind and no pass-through of raw markup: MarkdownMessage.tsx maps these tokens
 * to React elements, so no HTML string is ever constructed anywhere on the path
 * from agent output to the DOM. That is the structural guarantee against XSS —
 * not an escaping pass that can be forgotten. This renders LLM output derived
 * from user input, in a session holding two Postgres connection URLs; do NOT
 * replace it with `marked` piped into raw-HTML injection (the TextPanel
 * precedent renders author-written text — a different trust level; its prop
 * name is deliberately not written out here because the reviewer probe greps
 * this directory for it and must stay empty).
 *
 * Supported, and nothing else: paragraphs, ordered lists (`1.`), unordered
 * lists (`-`, `*`), inline `**bold**`, inline `` `code` ``. Everything
 * unrecognised falls through as literal text, including unclosed `**` and any
 * raw HTML.
 *
 * Hand-rolled with indexOf scanning instead of regex alternation so a large
 * hostile input cannot trigger catastrophic backtracking.
 */

export type MdSpan =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string };

export type MdBlock =
  | { kind: 'p'; spans: MdSpan[] }
  /** `start` is the ordinal of the block's FIRST item, for `<ol start>`. A
   *  loose list (blank lines between numbered items) tokenizes as one ol
   *  block per item; without `start`, every one of them would render as "1."
   *  — and numbered interview questions are the agent's flagship output. */
  | { kind: 'ol'; start: number; items: MdSpan[][] }
  | { kind: 'ul'; items: MdSpan[][] };

const OL_ITEM_RE = /^\s*(\d+)\.\s+(.*)$/;
const UL_ITEM_RE = /^\s*[-*]\s+(.*)$/;

/** Ordinal for `<ol start>`: a sane positive integer, else 1. The regex only
 *  admits digits, so this guards absurd lengths (e.g. a 30-digit "ordinal"
 *  parsing to an unsafe float), not signs or garbage. */
function parseOrdinal(digits: string): number {
  const n = Number.parseInt(digits, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/** Tokenize one line's (or one joined paragraph's) inline content. */
export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let plainStart = 0;
  let i = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      spans.push({ kind: 'text', value: text.slice(plainStart, end) });
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      // Code binds before bold: `**not bold**` is one code span whose value
      // keeps the literal asterisks.
      const close = text.indexOf('`', i + 1);
      if (close !== -1) {
        flushPlain(i);
        spans.push({ kind: 'code', value: text.slice(i + 1, close) });
        i = close + 1;
        plainStart = i;
        continue;
      }
      // Unclosed backtick: literal text, keep scanning.
      i += 1;
      continue;
    }
    if (ch === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close !== -1) {
        flushPlain(i);
        spans.push({ kind: 'bold', value: text.slice(i + 2, close) });
        i = close + 2;
        plainStart = i;
        continue;
      }
      // Unclosed **: literal text — never dropped.
      i += 1;
      continue;
    }
    i += 1;
  }

  flushPlain(text.length);
  return spans;
}

/** Tokenize a whole message into blocks. Never throws. */
export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraphLines: string[] = [];
  let list:
    | { kind: 'ol'; start: number; items: MdSpan[][] }
    | { kind: 'ul'; items: MdSpan[][] }
    | null = null;

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      // Joined with '\n' and rendered whitespace-pre-wrap: adjacent prose
      // lines keep their line breaks, which reads better in a chat bubble
      // than markdown's soft-break collapse.
      blocks.push({ kind: 'p', spans: parseInline(paragraphLines.join('\n')) });
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const ol = OL_ITEM_RE.exec(line);
    const ul = ol ? null : UL_ITEM_RE.exec(line);
    if (ol || ul) {
      flushParagraph();
      // Both `-` and `*` markers coalesce into one list; an ol item after a
      // ul (or vice versa) starts a new list block. A contiguous ol keeps the
      // first item's ordinal and numbers sequentially from there (the agent
      // emits 1..n); a loose ol re-enters here per item, each block carrying
      // its own ordinal.
      if (ol) {
        if (!list || list.kind !== 'ol') {
          flushList();
          list = { kind: 'ol', start: parseOrdinal(ol[1]), items: [] };
        }
        list.items.push(parseInline(ol[2]));
      } else {
        if (!list || list.kind !== 'ul') {
          flushList();
          list = { kind: 'ul', items: [] };
        }
        list.items.push(parseInline(ul![1]));
      }
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

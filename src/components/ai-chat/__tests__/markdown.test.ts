import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseMarkdown, type MdBlock, type MdSpan } from '../markdown';

/**
 * RECONSTRUCTED — NOT a verbatim capture. Mirrors the constant in
 * backend/src/services/agent/__tests__/interpretResponse.test.ts (the frontend
 * cannot import backend test modules): head and tail restored from the probe's
 * recorded excerpt, middle prose plausible filler, the probe's real job id
 * substituted into the URL.
 */
const RECONSTRUCTED_JOB_ID = '39f24779-a09e-4cc9-b901-0cf062c9b853';
const RECONSTRUCTED_URL = `s3://iot-query-dashboard-ai-agent-dev-dashboard-artifacts-fe0e8aa7/jobs/${RECONSTRUCTED_JOB_ID}/report_schema.json`;
const RECONSTRUCTED_BUILD_REPLY = [
  'Your dashboard has been built and saved successfully! \u{1F389}',
  '',
  'Here is a summary of what was created:',
  '',
  '- \u{1F4CA} Title: Vehicle Mileage by Driver — Last 30 Days',
  '- \u{1F9E9} Panels: 4 (text, kpi, barchart, table)',
  `- \u{1F194} Job ID: \`${RECONSTRUCTED_JOB_ID}\``,
  '- \u{1F4E5} Download URL:',
  `\`${RECONSTRUCTED_URL}\``,
  '',
  'You can preview it against your data and apply it when ready.',
].join('\n');

function allSpans(blocks: MdBlock[]): MdSpan[] {
  return blocks.flatMap((block) =>
    block.kind === 'p' ? block.spans : block.items.flat(),
  );
}

describe('parseMarkdown', () => {
  it('returns [] for empty and whitespace-only input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n  ')).toEqual([]);
  });

  it('splits two paragraphs on a blank line', () => {
    const blocks = parseMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('p');
    expect(blocks[1].kind).toBe('p');
  });

  it('parses a numbered list into one ol with three items — the shape the real agent emits', () => {
    const blocks = parseMarkdown('1. a\n2. b\n3. c');
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.kind).toBe('ol');
    if (block.kind !== 'ol') throw new Error('unreachable');
    expect(block.items).toHaveLength(3);
    expect(block.items[0]).toEqual([{ kind: 'text', value: 'a' }]);
    expect(block.items[2]).toEqual([{ kind: 'text', value: 'c' }]);
  });

  it('coalesces - and * markers into one ul', () => {
    const blocks = parseMarkdown('- a\n* b');
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.kind).toBe('ul');
    if (block.kind !== 'ul') throw new Error('unreachable');
    expect(block.items).toHaveLength(2);
  });

  it('keeps paragraph, list, paragraph in order', () => {
    const blocks = parseMarkdown('Intro.\n\n1. one\n2. two\n\nOutro.');
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'ol', 'p']);
  });

  it('tokenizes **bold** followed by plain text as a bold span then a text span', () => {
    const blocks = parseMarkdown('**bold** and plain');
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== 'p') throw new Error('unreachable');
    expect(blocks[0].spans).toEqual([
      { kind: 'bold', value: 'bold' },
      { kind: 'text', value: ' and plain' },
    ]);
  });

  it('binds code before bold: `**not bold**` is a single code span with literal asterisks', () => {
    const blocks = parseMarkdown('`**not bold**`');
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== 'p') throw new Error('unreachable');
    expect(blocks[0].spans).toEqual([{ kind: 'code', value: '**not bold**' }]);
  });

  it('keeps an unclosed ** as literal text — never dropped', () => {
    const blocks = parseMarkdown('**unclosed');
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== 'p') throw new Error('unreachable');
    expect(blocks[0].spans).toEqual([{ kind: 'text', value: '**unclosed' }]);
  });

  it('passes raw HTML through as a literal text span — the union has no html kind', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const blocks = parseMarkdown(payload);
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== 'p') throw new Error('unreachable');
    expect(blocks[0].spans).toEqual([{ kind: 'text', value: payload }]);
    // Structural guarantee, checked at compile time: there is no 'html' block
    // kind to smuggle markup through. Adding one stops this test compiling.
    expectTypeOf<Extract<MdBlock, { kind: 'html' }>>().toBeNever();
    expectTypeOf<Extract<MdSpan, { kind: 'html' }>>().toBeNever();
  });

  it('parses the reconstructed real build response; the s3:// URL survives verbatim', () => {
    const blocks = parseMarkdown(RECONSTRUCTED_BUILD_REPLY);
    expect(blocks.length).toBeGreaterThan(0);
    const spans = allSpans(blocks);
    expect(spans.some((s) => s.kind === 'code' && s.value === RECONSTRUCTED_URL)).toBe(true);
    expect(spans.some((s) => s.kind === 'code' && s.value === RECONSTRUCTED_JOB_ID)).toBe(true);
  });

  it('handles a 100 KB single line without catastrophic backtracking', () => {
    // Near-token soup: lots of '*' and '`' that mostly fail to close. The
    // tokenizer is an indexOf scanner, so this is O(n); a backtracking regex
    // implementation would take seconds to minutes here. The bound is left
    // generous for slow CI — the failure mode is orders of magnitude over it.
    const line = '*a`b'.repeat(25_000);
    expect(line).toHaveLength(100_000);
    const startedAt = performance.now();
    const blocks = parseMarkdown(line);
    const elapsedMs = performance.now() - startedAt;
    expect(blocks).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(250);
  });
});

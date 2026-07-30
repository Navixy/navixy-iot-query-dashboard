/**
 * Removes the artifact's s3:// URL — and the scaffolding that exists only to
 * carry it — from the prose that becomes the chat bubble (DO-313).
 *
 * WHY. toDashboardResult renders the agent's own prose verbatim, and the build
 * reply advertises the artifact: a "Download URL" row holding
 * `s3://<bucket>/jobs/<job-id>/report_schema.json`, then an `aws s3 cp` snippet.
 * Two problems with showing that. The bucket name is internal infrastructure,
 * and bedrockAgent's error paths already scrub AWS identifiers out of
 * user-facing text (safeUserMessage) — the happy path was the hole left open.
 * And the copy command is useless to a browser user, who has no AWS credentials
 * and does not need them: the dashboard JSON is already in the response's
 * `result`.
 *
 * WHY IT IS MORE THAN A replace(). Deleting the URL in place leaves husks the
 * user can see, because the agent always wraps it:
 *
 *     | **Download URL** | `s3://…/report_schema.json` |
 *  -> | **Download URL** | `` |
 *
 *     ```bash
 *     aws s3 cp s3://…/report_schema.json ./report_schema.json
 *     ```
 *  -> ```bash
 *     aws s3 cp  ./report_schema.json
 *     ```
 *
 * and the chat renderer parses neither tables nor fences — src/components/
 * ai-chat/markdown.ts emits only p/ol/ul — so both husks reach the bubble as
 * literal pipe-and-backtick text. Removal is therefore by LINE, and the label
 * introducing a removed line goes with it.
 *
 * PURE, and it works by SHAPE rather than by matching the one URL
 * interpretResponse extracted, so a reply carrying two URLs — or one the
 * classifier rejected as implausible — still comes out clean.
 *
 * SCOPE. Applied to result turns, the only ones that can carry an artifact URL:
 * a question turn is *defined* as prose with no s3:// URL (interpretResponse.ts,
 * fromProseHeuristic). The one gap is the proposed structured trailer (§3.4.4)
 * marking type:'question' over prose that mentions a URL anyway — that trailer
 * does not exist yet, and if it ever ships this call moves up to cover both arms.
 */

/** Deliberate twin of interpretResponse's S3_URL_RE: the same character class,
 *  so what the classifier can find is exactly what this can remove. Kept
 *  separate rather than shared because that one must stay non-global — a /g
 *  regex carries lastIndex between calls — while this one needs every
 *  occurrence. A test uses the classifier as the oracle to pin the twins. */
const S3_URL = /s3:\/\/[^\s`'")<>[\]]+/;

/** The URL plus whatever wrapper it arrived in, so no empty husk survives: a
 *  markdown link's `[label]()`, or inline code's ``. */
const WRAPPED_S3_URL_G = new RegExp(
  [
    // [label](s3://…) — wrapper and all.
    '\\[[^\\]]*\\]\\(\\s*' + S3_URL.source + '\\s*\\)',
    // `s3://…` — inline code, the form the agent actually emits.
    '`+\\s*' + S3_URL.source + '\\s*`+',
    // Bare. LAST, because alternation is first-match: an earlier bare branch
    // would win and leave the wrapper behind.
    S3_URL.source,
  ].join('|'),
  'g',
);

/** Opens or closes a fenced block, at any indent. */
const FENCE_RE = /^\s*(?:```|~~~)/;

/** A markdown table row — how the agent formats its build details. */
const TABLE_ROW_RE = /^\s*\|/;

/** The `|---|---:|` row under a table header. */
const TABLE_DELIMITER_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

/** A line whose text ends at a colon, ignoring trailing emphasis — so both
 *  `…you can run:` and `**Build Details:**` count. Such a line introduces what
 *  follows and is dead once that is gone. */
const LABEL_RE = /:[*_~`\s]*$/;

/** Markdown furniture, so "did this line say anything besides the URL" is judged
 *  on content rather than on punctuation left behind. */
function contentOf(line: string): string {
  return line.replace(/[|`*_~#>:\-\s]/g, '');
}

function saysSomething(line: string): boolean {
  return /[\p{L}\p{N}]/u.test(contentOf(line));
}

/** Inclusive index ranges of fenced blocks. An unterminated fence runs to the
 *  end — the reading a markdown renderer gives it, and the safe one here, since
 *  a URL inside must not survive on a technicality. */
function fenceRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: number | null = null;
  for (const [i, line] of lines.entries()) {
    if (!FENCE_RE.test(line)) continue;
    if (open === null) open = i;
    else {
      ranges.push([open, i]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open, lines.length - 1]);
  return ranges;
}

/**
 * Prose with every s3:// URL and its carrier removed. Prose that has no URL is
 * returned BYTE-IDENTICAL — not merely equivalent — so a clean reply provably
 * passes through untouched.
 */
export function stripArtifactUrls(prose: string): string {
  if (!S3_URL.test(prose)) return prose;

  const lines = prose.split('\n');
  const drop = new Set<number>();
  const rewritten = new Map<number, string>();

  /** Out of range reads as blank, which is the right answer at every call site
   *  below: a line that is not there is no label, no table row and no URL. */
  const at = (i: number): string => lines[i] ?? '';

  // 1. A fenced block goes whole if any line inside carries a URL: half a
  //    command is worse than no command, and fences render literally here.
  const inFence = new Set<number>();
  for (const [start, end] of fenceRanges(lines)) {
    let carriesUrl = false;
    for (let i = start; i <= end; i++) {
      inFence.add(i);
      if (S3_URL.test(at(i))) carriesUrl = true;
    }
    if (carriesUrl) for (let i = start; i <= end; i++) drop.add(i);
  }

  // 2. Outside fences, line by line.
  for (const [i, line] of lines.entries()) {
    if (inFence.has(i) || !S3_URL.test(line)) continue;

    // A table row is a label/value record ABOUT the URL, so it goes with it;
    // excising in place would leave `| **Download URL** | |`.
    if (TABLE_ROW_RE.test(line)) {
      drop.add(i);
      continue;
    }

    const without = line.replace(WRAPPED_S3_URL_G, '');
    if (saysSomething(without) && !LABEL_RE.test(without)) {
      // The line said something of its own — keep the sentence, close the gap.
      rewritten.set(i, without.replace(/[ \t]{2,}/g, ' ').trimEnd());
    } else {
      // Nothing left, or nothing but a caption the URL was the value of
      // (`Download URL:`), which is dead the moment the URL goes.
      drop.add(i);
    }
  }

  // 3. A table whose only body row was the URL row is now a header and a
  //    delimiter with nothing under them, which the renderer shows as literal
  //    pipes. Take the husk with the row.
  for (const [i, line] of lines.entries()) {
    if (drop.has(i) || !TABLE_DELIMITER_RE.test(line)) continue;
    let bodyRows = 0;
    for (let j = i + 1; j < lines.length && TABLE_ROW_RE.test(at(j)); j++) {
      if (!drop.has(j)) bodyRows++;
    }
    if (bodyRows > 0) continue;
    drop.add(i);
    if (i > 0 && TABLE_ROW_RE.test(at(i - 1))) drop.add(i - 1);
  }

  // 4. The label above removed content goes too — "you can run:" with nothing
  //    to run, "- 📥 Download URL:" with no URL under it. Iterated to a fixed
  //    point so a label chain leaves together; every step requires a colon, so
  //    this cannot run away into ordinary prose.
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = lines.length - 2; i >= 0; i--) {
      if (drop.has(i) || rewritten.has(i) || !LABEL_RE.test(at(i))) continue;
      // Look past blank lines: `**Build Details:**` with a paragraph break
      // before its table is as dead as a lead-in directly above its fence.
      let j = i + 1;
      while (j < lines.length && at(j).trim() === '') j++;
      if (j >= lines.length || !drop.has(j)) continue;
      drop.add(i);
      changed = true;
    }
  }

  const kept: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (drop.has(i)) continue;
    kept.push(rewritten.get(i) ?? line);
  }

  // Whole lines leaving behind blank runs would open gaps the prose never had.
  // Collapse to the single blank line that is a paragraph break.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

import { describe, it, expect } from '@jest/globals';
import {
  droppedQuestionsTelemetry,
  interpretAgentResponse,
  looksLikeDroppedQuestions,
  looksLikeMissedResult,
  type AgentIntent,
} from '../interpretResponse.js';

/**
 * RECONSTRUCTED — NOT a verbatim capture.
 *
 * The only surviving record of the real build reply is the elided excerpt at
 * ai-chat-plan.local/PROBE-FINDINGS.md:33-39 ("..." standing for the middle
 * prose, "<job-id>" substituted into the URL). The head and tail lines below
 * restore what the excerpt records exactly; the middle prose is plausible
 * filler; the probe's real job id is substituted back into the URL. Do not
 * treat the wording as a contract — classification deliberately keys on the
 * s3:// URL alone.
 */
const RECONSTRUCTED_JOB_ID = '39f24779-a09e-4cc9-b901-0cf062c9b853';
const RECONSTRUCTED_URL =
  `s3://iot-query-dashboard-ai-agent-dev-dashboard-artifacts-fe0e8aa7/jobs/${RECONSTRUCTED_JOB_ID}/report_schema.json`;
const RECONSTRUCTED_BUILD_REPLY = [
  'Your dashboard has been built and saved successfully! 🎉',
  '',
  'Here is a summary of what was created:',
  '',
  '- 📊 Title: Vehicle Mileage by Driver — Last 30 Days',
  '- 🧩 Panels: 4 (text, kpi, barchart, table)',
  `- 🆔 Job ID: \`${RECONSTRUCTED_JOB_ID}\``,
  '- 📥 Download URL:',
  `\`${RECONSTRUCTED_URL}\``,
  '',
  'You can preview it against your data and apply it when ready.',
].join('\n');

const FIVE_QUESTIONS = [
  'Happy to build that! A few questions first:',
  '',
  '1. Which vehicles or groups should be included?',
  '2. What time range do you want to cover?',
  '3. Should distances be shown in km or miles?',
  '4. Do you want per-driver or per-vehicle grouping?',
  '5. Any thresholds you want highlighted?',
].join('\n');

describe('interpretAgentResponse — prose heuristic (§3.4.2)', () => {
  it('classifies the reconstructed real build reply as a result and lifts URL and job id', () => {
    const intent = interpretAgentResponse(RECONSTRUCTED_BUILD_REPLY);
    expect(intent.type).toBe('result');
    expect(intent.via).toBe('heuristic');
    expect(intent.artifactUrl).toBe(RECONSTRUCTED_URL);
    expect(intent.jobId).toBe(RECONSTRUCTED_JOB_ID);
    // The heuristic never synthesizes or strips: the bubble shows the prose verbatim.
    expect(intent.message).toBe(RECONSTRUCTED_BUILD_REPLY);
  });

  it('classifies a five-question numbered markdown list with no URL as a question, verbatim', () => {
    const intent = interpretAgentResponse(FIVE_QUESTIONS);
    expect(intent).toEqual({ type: 'question', via: 'heuristic', message: FIVE_QUESTIONS });
    expect(intent.artifactUrl).toBeUndefined();
  });

  it('strips wrapping backticks and trailing punctuation from the extracted URL', () => {
    const wrapped = interpretAgentResponse('Saved to `s3://bucket/jobs/a/report_schema.json`');
    expect(wrapped.artifactUrl).toBe('s3://bucket/jobs/a/report_schema.json');

    const period = interpretAgentResponse('Download s3://bucket/jobs/a/report_schema.json.');
    expect(period.artifactUrl).toBe('s3://bucket/jobs/a/report_schema.json');

    const comma = interpretAgentResponse('See s3://bucket/jobs/a/report_schema.json, then apply.');
    expect(comma.artifactUrl).toBe('s3://bucket/jobs/a/report_schema.json');

    // Legitimate dots inside the key survive; only trailing punctuation goes.
    expect(period.artifactUrl?.endsWith('.json')).toBe(true);
  });

  it('strips the full trailing-punctuation family the URL character class lets through (MR !57 review)', () => {
    // Each of these reached parseS3Url polluted before the fix, turning a
    // SUCCESSFUL build into a NoSuchKey "no longer available" error.
    const clean = 's3://bucket/jobs/a/report_schema.json';
    for (const punct of ['!', ';', '?', ':', '...', '!?', '~']) {
      const intent = interpretAgentResponse(`Saved to ${clean}${punct} enjoy.`);
      expect(intent.artifactUrl).toBe(clean);
    }
    // Markdown emphasis wrapping: the leading ** is outside the match, the
    // trailing ** must be stripped.
    expect(interpretAgentResponse(`Saved to **${clean}**`).artifactUrl).toBe(clean);
  });

  it('keeps square brackets out of the URL — a bracket-wrapped key polluted the fetch (MR !57 review)', () => {
    const clean = 's3://bucket/jobs/a/report_schema.json';
    // Plain bracket wrapping, as markdown renderers and citation styles emit it.
    expect(interpretAgentResponse(`Saved to [${clean}]`).artifactUrl).toBe(clean);
    // A markdown link whose TEXT is the URL: the match must stop at the closing
    // bracket instead of swallowing "](...)" into the key.
    expect(interpretAgentResponse(`Download [${clean}](${clean})`).artifactUrl).toBe(clean);
  });

  it('flags a job id with no URL as a possible missed result, still classified as question', () => {
    const prose = 'Your dashboard has been built! Job ID: `1b7f3c3a-0000-4abc-9def-123456789abc`.';
    const intent = interpretAgentResponse(prose);
    expect(intent.type).toBe('question');
    expect(looksLikeMissedResult(prose)).toBe(true);
    // An ordinary clarifying question carries none of the markers.
    expect(looksLikeMissedResult(FIVE_QUESTIONS)).toBe(false);
  });

  // One probe per marker (MR !57 review): this guard is the mitigation for the
  // heuristic's silent failure mode, and each marker must be individually
  // load-bearing — deletable only with a red suite.
  it.each([
    ['job id', 'The job id will be emailed to you shortly.'],
    ['dashboard has been built', 'Your dashboard has been built and is being uploaded now.'],
    ['report_schema', 'Writing report_schema now, one moment.'],
  ])('looksLikeMissedResult fires on the "%s" marker alone', (_marker, prose) => {
    expect(looksLikeMissedResult(prose)).toBe(true);
    expect(interpretAgentResponse(prose).type).toBe('question');
  });

  it('returns question with the input verbatim for empty and whitespace-only prose', () => {
    expect(interpretAgentResponse('')).toEqual({ type: 'question', via: 'heuristic', message: '' });
    expect(interpretAgentResponse('  \n\t ')).toEqual({
      type: 'question',
      via: 'heuristic',
      message: '  \n\t ',
    });
  });
});

describe('interpretAgentResponse — trailer (§3.4.4, proposed and NOT agreed)', () => {
  const PROSE = 'Your dashboard is ready to preview.';

  it('takes a result trailer, stripping the fence from the message', () => {
    const raw = `${PROSE}\n\n\`\`\`json\n{"type":"result","job_id":"j-1","artifact":"s3://b/k.json"}\n\`\`\``;
    const intent = interpretAgentResponse(raw);
    expect(intent.type).toBe('result');
    expect(intent.via).toBe('trailer');
    expect(intent.artifactUrl).toBe('s3://b/k.json');
    expect(intent.jobId).toBe('j-1');
    // The trailer is machinery; the user must never see it.
    expect(intent.message).toBe(PROSE);
  });

  it('takes a question trailer', () => {
    const raw = `${PROSE}\n\n\`\`\`json\n{"type":"question"}\n\`\`\``;
    const intent = interpretAgentResponse(raw);
    expect(intent).toEqual({ type: 'question', via: 'trailer', message: PROSE });
  });

  it('uses the LAST fenced block, so a code sample in the prose cannot be mistaken for the trailer', () => {
    const raw = [
      'Here is the SQL I used:',
      '```sql',
      'SELECT device_id FROM processed_common_data.trips',
      '```',
      'All done.',
      '```json',
      '{"type":"question"}',
      '```',
    ].join('\n');
    const intent = interpretAgentResponse(raw);
    expect(intent.type).toBe('question');
    expect(intent.via).toBe('trailer');
    // Only the trailer block is stripped; the code sample stays in the bubble.
    expect(intent.message).toContain('SELECT device_id');
    expect(intent.message).not.toContain('"type"');
  });

  it('ignores a NON-TERMINAL trailer-shaped block — prose after the fence means it is prose (MR !57 review)', () => {
    // Reproduced defect: a mid-response {"type":"question"} block used to win over a
    // later, perfectly valid result URL, turning a successful build into a question.
    const raw = [
      'Let me check something first:',
      '```json',
      '{"type":"question"}',
      '```',
      'Actually it is already done! Saved to',
      `\`${RECONSTRUCTED_URL}\``,
    ].join('\n');
    const intent = interpretAgentResponse(raw);
    expect(intent.type).toBe('result');
    expect(intent.via).toBe('heuristic');
    expect(intent.artifactUrl).toBe(RECONSTRUCTED_URL);
    // Not a trailer, so nothing is stripped: the bubble shows the raw prose verbatim.
    expect(intent.message).toBe(raw);
  });

  it('a non-terminal trailer-shaped block with no URL after it is still a question, shown verbatim', () => {
    const raw = 'Thinking:\n```json\n{"type":"result"}\n```\nWhat time range do you want?';
    expect(interpretAgentResponse(raw)).toEqual({
      type: 'question',
      via: 'heuristic',
      message: raw,
    });
  });

  it('still takes a terminal trailer that is followed only by whitespace', () => {
    const raw = `${PROSE}\n\n\`\`\`json\n{"type":"question"}\n\`\`\`\n\n  `;
    const intent = interpretAgentResponse(raw);
    expect(intent.type).toBe('question');
    expect(intent.via).toBe('trailer');
    expect(intent.message).toBe(PROSE);
  });

  it('falls through to the heuristic on any unusable trailer, and never throws', () => {
    // Malformed JSON.
    expect(interpretAgentResponse('Prose.\n```json\n{not json}\n```').via).toBe('heuristic');
    // Non-object bodies.
    expect(interpretAgentResponse('Prose.\n```json\nnull\n```').via).toBe('heuristic');
    expect(interpretAgentResponse('Prose.\n```json\n[1,2]\n```').via).toBe('heuristic');
    // type:'error' is OURS — an agent-emitted one is a contract violation.
    expect(interpretAgentResponse('Prose.\n```json\n{"type":"error"}\n```').via).toBe('heuristic');
    // A result with no artifact is not a result.
    expect(interpretAgentResponse('Prose.\n```json\n{"type":"result"}\n```').via).toBe('heuristic');
    // ...nor with an implausible one.
    expect(
      interpretAgentResponse('Prose.\n```json\n{"type":"result","artifact":"https://x/y"}\n```').via,
    ).toBe('heuristic');
    expect(
      interpretAgentResponse('Prose.\n```json\n{"type":"result","artifact":"s3://bucketonly"}\n```')
        .via,
    ).toBe('heuristic');

    // Fallthrough keeps the heuristic's own classification power: a malformed
    // trailer NEXT TO a plain-prose URL still classifies as a result.
    const mixed = interpretAgentResponse(
      'Saved to s3://bucket/jobs/a/report_schema.json\n```json\n{broken\n```',
    );
    expect(mixed).toMatchObject({ type: 'result', via: 'heuristic' });
  });
});

/**
 * DO-380 — the truncated-interview-reply detector.
 *
 * Every string below is a VERBATIM delivered reply captured from the live agent
 * (`agent TWLIGJKDJ2 / alias 7QMZDGXBUM / eu-central-1`, 2026-08-03) across 18
 * dialogues / 72 turns. They are the ground truth this rule was measured against:
 * 6 of 6 real defects caught, 0 false positives, 0 missed.
 *
 * ONLY THE ENGLISH CAPTURES ARE INLINED. This repository is English-only and mirrors
 * publicly, so the five non-English captures stay in the DO-380 investigation rather
 * than here. The defect is NOT language-specific, which is what the English control
 * below establishes. (An earlier report claimed it was; the larger sample disproved
 * that.)
 *
 * The RULE, however, was language-dependent, and that was a defect in it (MR !67 review).
 * `includes('?')` over an English markdown list scored a Chinese, Arabic, `+`-bulleted or
 * `•`-bulleted interview reply as a failure. Since the numerator is this MR's whole
 * deliverable, those false positives argued for expensive upstream work on evidence that
 * was not real. Both families are now widened; `describe('multilingual and list-marker
 * families')` below pins them, using constructed strings rather than captures because the
 * corpus has no CJK or RTL turn to quote. Every widening moves one way — fewer flags —
 * so the lower bound stays a bound.
 *
 * The healthy cases matter more than the broken ones. Each defeats a rule that looks
 * reasonable and is wrong:
 *
 *   - the 47-char reply defeats every length threshold. The shortest MEASURED failure
 *     was 54 chars — longer than this healthy one — so no cut-off separates them.
 *   - the "one at a time" replies defeat "must contain questions 1-4", the rule the
 *     agent's author proposed. It scores 40 % precision on this sample and fires
 *     hardest on the agent CORRECTLY de-escalating after a user complains.
 *
 * Delete one of these and the suite stays green while the detector rots back into a
 * rule we already measured as wrong.
 */
describe('looksLikeDroppedQuestions (DO-380)', () => {
  it('flags the delivered-sign-off-only failure (EN control, 93 chars)', () => {
    // The reasoning committed to asking questions; this sign-off is all that arrived.
    const reply =
      "Please go ahead and answer the above — I'm ready to build as soon as I have those details! 😊";
    expect(looksLikeDroppedQuestions(reply)).toBe(true);
    // The caller only consults this on question turns; confirm this is typed so.
    expect(interpretAgentResponse(reply).type).toBe('question');
  });

  it.each([
    ['47ch — shorter than the 54ch shortest failure, and healthy', 'What would you like to track on your dashboard?'],
    ['de-escalation to one question', 'Sure! Here they are, one by one:\n\n**What metrics do you want to track on your dashboard?**'],
    ['apology then a single question', 'I apologize! Here is my question:\n\n**What do you want to track on your dashboard?**'],
    ['acknowledgement then a single question', "You're right, I apologize! Here are my questions:\n\n**What do you want to track on your dashboard?**"],
  ])('does NOT flag a healthy reply that asks something: %s', (_label, reply) => {
    expect(looksLikeDroppedQuestions(reply)).toBe(false);
  });

  it('still flags a non-English sign-off, and clears a non-English question', () => {
    // Stands in for the five non-English captures. Multi-byte characters and emoji must
    // not perturb either test — the failure rate on the non-English path measured ~4x
    // the English one, so this path carries most of the volume.
    expect(looksLikeDroppedQuestions('Ich warte auf Ihre Antworten — dann baue ich es! 🚗📊')).toBe(true);
    expect(looksLikeDroppedQuestions('Was möchten Sie auf dem Dashboard sehen?')).toBe(false);
  });

  it('does not flag a numbered list even if the items carry no question mark', () => {
    // The full interview arrived; the questions are simply phrased as imperatives.
    // A list IS the thing the failure is missing, so its presence clears the turn.
    expect(looksLikeDroppedQuestions('Tell me:\n1. the metric\n2. the time range')).toBe(false);
    expect(looksLikeDroppedQuestions('Tell me:\n- the metric\n- the time range')).toBe(false);
  });

  it('KNOWN UNDER-COUNT: a sign-off phrased as a question reads as healthy', () => {
    // The rule's one blind spot, pinned so it stays a known limit. What survives the
    // truncation is a closing line, and a closing line is the sentence most likely to
    // carry a question mark — so the rate this feeds is a LOWER BOUND and has to be
    // reported as one. Flip this expectation and you have re-derived "any short reply
    // is broken", which the 47-char healthy control above already disproves.
    expect(
      looksLikeDroppedQuestions('Could you answer the four questions above so I can build it?'),
    ).toBe(false);
  });

  it('is total: empty and whitespace-only prose do not throw', () => {
    // Contract test for a pure predicate, NOT a reachable state: collectCompletion
    // throws EmptyCompletion on a whitespace-only drain, so an empty reply fails the
    // turn in band and never reaches this rule. Totality is still worth pinning —
    // nothing in the signature says the caller must pre-filter.
    expect(looksLikeDroppedQuestions('')).toBe(true);
    expect(looksLikeDroppedQuestions('   \n  ')).toBe(true);
  });

  it('overlaps looksLikeMissedResult, which is why the gate excludes it', () => {
    // A build reply that lost its URL asks nothing, so it scores true on BOTH — yet it
    // is POSSIBLE_MISSED_RESULT, a different defect. The predicates cannot tell them
    // apart and are not meant to; droppedQuestionsTelemetry owns that gate, and the
    // suite below proves such a turn leaves BOTH sides of the rate.
    const missedBuild = 'Your dashboard has been built and is being uploaded now.';
    expect(looksLikeMissedResult(missedBuild)).toBe(true);
    expect(looksLikeDroppedQuestions(missedBuild)).toBe(true);

    // The genuine defect carries no build marker, so the gate lets it through.
    const droppedInterview = "I'm ready to build as soon as I have those details!";
    expect(looksLikeMissedResult(droppedInterview)).toBe(false);
    expect(looksLikeDroppedQuestions(droppedInterview)).toBe(true);
  });
});

/**
 * MR !67 review — the rule must not read "asks nothing" as "is not English markdown".
 *
 * On the reviewed SHA `looksLikeDroppedQuestions` tested `raw.includes('?')` against a
 * list regex accepting only `-`, `*` and ASCII `1.`/`1)`. Every reply in this suite is a
 * HEALTHY interview turn, and every one of them scored as a failure. That direction is
 * the expensive one: the numerator is what this MR exists to produce, and inflating it
 * with healthy replies argues for upstream work the traffic may not justify.
 *
 * Constructed, not captured — the 72-turn corpus is English and Russian only, so it has
 * no CJK or RTL turn to quote. What IS from the corpus is the shape: `**1. …**` is this
 * agent's dominant numbered form (20 of the 72 healthy replies carry no marker the old
 * regex could see and were cleared by their `?` alone), and it bullets question lines
 * with 👉 / 🔹 / ❓ in four more. Re-scored on that corpus after these widenings, and again
 * after round 2's narrowing: still 6 of 6 caught, 0 false positives, 0 missed.
 */
describe('looksLikeDroppedQuestions — multilingual and list-marker families (!67)', () => {
  it.each([
    // The four the review reproduced against the exported function on the reviewed SHA.
    ['`+` bullets — CommonMark\'s third marker', 'Provide:\n+ metric\n+ range'],
    ['`•` bullets — a rendered list', 'Provide:\n• metric\n• range'],
    ['fullwidth question mark U+FF1F (CJK)', '需要哪些指标？'],
    ['Arabic question mark U+061F', 'ما الذي تريد تتبعه؟'],
  ])('does NOT flag a healthy reply: %s', (_label, reply) => {
    expect(looksLikeDroppedQuestions(reply)).toBe(false);
  });

  it.each([
    ['Armenian U+055E', 'Ի՞նչ եք ուզում տեսնել'],
    ['Ethiopic U+1367', 'ምን ማየት ይፈልጋሉ፧'],
    ['Spanish opener alone U+00BF', '¿Qué desea ver en el panel'],
    ['question ornament U+2753 — this agent bullets with it', 'Tell me what to track ❓'],
    ['small form U+FE56', '追跡したいのは﹖'],
  ])('does NOT flag a question in another script: %s', (_label, reply) => {
    expect(looksLikeDroppedQuestions(reply)).toBe(false);
  });

  // SINGLE LINE, deliberately, and each carries no question mark: the marker is then the
  // ONLY thing clearing the reply, so these fail if a family is narrowed or deleted. Write
  // them as the multi-line lists they are drawn from and they pass on the line count alone
  // (round 2 added that conjunct) — the regexes would be free to rot underneath.
  it.each([
    ['fullwidth digits + U+FF0E, no space (CJK typography)', '１．指标'],
    ['ideographic comma U+3001, no space', '1、指標'],
    ['ideographic full stop U+3002', '2。期間'],
    ['circled numerals U+2460', '① the metric'],
    ['parenthesised numerals U+2474', '⑴ the metric'],
    ['Arabic-Indic digits', '١. metric'],
    ["`**1. …**` — this agent's dominant numbered form", '**1. What to track**'],
    ['`**1.** …` — emphasis closing before the space', '**1.** the metric'],
    ['em-dash bullets U+2014', '— the metric'],
    ['en-dash bullets U+2013', '– the metric'],
    ['`+` bullets', '+ the metric'],
    ['indented bullets', '  - the metric'],
  ])('does NOT flag a one-line item written as: %s', (_label, reply) => {
    expect(looksLikeDroppedQuestions(reply)).toBe(false);
  });

  it('an emoji-bulleted list is cleared by the line count, not by an emoji regex', () => {
    // Round 1 matched emoji bullets with their own pattern, gated on a preceding line so a
    // rocket on a sign-off stayed flagged. Round 2's single-line conjunct expresses the
    // same thing for every marker at once, so that pattern is gone. Both halves of what it
    // decided still hold, which is why it could go.
    expect(looksLikeDroppedQuestions('Here they are:\n👉 the metric\n👉 the range')).toBe(false);
    expect(looksLikeDroppedQuestions('🚀 Ready as soon as you send those details!')).toBe(true);
  });

  it.each([
    // The widening must not swallow the defect. Each of these asks nothing, on one line.
    ['a decimal is not item 1', 'You have 1.5 million records ready to plot.'],
    ['a horizontal rule is not a bullet', '--- building now!'],
    ['a hash-number is not a marker', 'Report #1 is on its way.'],
    ['bold prose is not a list', '**Great news** — building it now.'],
    ['a leading emoji is decoration, not a bullet', '🚀 Ready as soon as you send those details!'],
    ['a trailing emoji is decoration', 'I am waiting for your answers, then I build it! 🚀📊'],
  ])('STILL flags: %s', (_label, reply) => {
    expect(looksLikeDroppedQuestions(reply)).toBe(true);
  });
});

/**
 * MR !67 review ROUND 2 — the three findings, executable.
 *
 * 1. The rule flagged healthy imperative replies. It still can, and the shape below is
 *    why: every one of the 6 measured failures is ITSELF an imperative ask, so the
 *    obvious remedy — recognise imperative asking and clear it — clears all six. What
 *    narrowed instead is the single-line conjunct, which is positive evidence of
 *    truncation rather than another absence. The residual false positive is PINNED, not
 *    fixed, and the rule for reporting around it lives in looksLikeDroppedQuestions.
 * 2. QUESTION_MARK held an ASCII U+003B behind a comment claiming U+037E, so any reply
 *    with a semicolon was cleared. U+037E canonically decomposes to U+003B, which is how
 *    a glyph became a semicolon in the first place; the class is escapes now.
 * 3. `\p{No}` was documented as circled/parenthesised numerals and is not — it carries
 *    fractions and superscripts too. Replaced by explicit ranges, pinned both ways.
 */
describe('looksLikeDroppedQuestions — review round 2 (!67)', () => {
  it.each([
    // Verbatim shape of all six measured failures: an imperative pointing at questions
    // that are not in the message. A test for "does it ask" clears every one of them.
    ['the EN capture', "Please go ahead and answer the above — I'm ready to build!"],
    ['the RU captures in shape', 'Please answer these 4 questions and I will build the dashboard!'],
  ])('the DEFECT is itself an imperative ask: %s', (_label, reply) => {
    expect(looksLikeDroppedQuestions(reply)).toBe(true);
  });

  it('KNOWN FALSE POSITIVE: a healthy one-line imperative with no question mark', () => {
    // The review's own example. Nothing in the 72 measured turns has this shape — all 66
    // healthy replies carry a question mark — and the case above is why no rule over one
    // message can separate it from the defect. The consequence is a REPORTING rule, in
    // looksLikeDroppedQuestions: the flag yields candidates, and the figure that reaches
    // DO-380 is the subset confirmed against chat_messages on the logged sessionId.
    //
    // Flipping this expectation means having found a rule that clears this and still
    // catches "Please answer these 4 questions and I will build the dashboard!".
    expect(looksLikeDroppedQuestions('Please provide the metric and time range.')).toBe(true);
  });

  it.each([
    ['German', 'Bitte nennen Sie die Kennzahl und den Zeitraum.'],
    ['Spanish', 'Indique la métrica y el intervalo de tiempo.'],
    ['French', 'Merci de préciser la métrique et la période.'],
    ['Turkish', 'Lütfen metriği ve zaman aralığını belirtin.'],
    ['Chinese', '请提供指标和时间范围。'],
    ['Japanese', '指標と期間を教えてください。'],
    ['Arabic', 'يرجى تحديد المقياس والفترة الزمنية.'],
  ])('the same limit is script-independent, not an English artefact: %s', (_label, reply) => {
    // Deliberately asserting TRUE. These are healthy imperatives in seven scripts and the
    // rule flags all of them, exactly as it flags the English one — the limit does not
    // discriminate by language, so a reader cannot mistake it for the round-1 defect,
    // where the RULE was English-specific. Written rather than captured: the corpus is
    // English and Russian only, and this repository stays English-only.
    expect(looksLikeDroppedQuestions(reply)).toBe(true);
  });

  it.each([
    ['a multi-line imperative asks visibly', 'Two things before I build:\nthe metric\nthe time range'],
    ['an intro plus a bare line', 'Understood.\n\nSend me the metric and the range.'],
  ])('a reply of more than one line is cleared: %s', (_label, reply) => {
    // The narrowing. A truncated reply is a lone closing line — 6 of 6 measured, against
    // 64 of 66 healthy replies running to several lines. Anything with a line above it
    // had room to ask, so it leaves the numerator whatever its markers look like. This is
    // the ONLY conjunct that is evidence rather than absence of evidence.
    expect(looksLikeDroppedQuestions(reply)).toBe(false);
  });

  it('an ordinary semicolon no longer clears a reply (the U+003B that shipped)', () => {
    // Round 1 put ASCII U+003B in QUESTION_MARK while documenting U+037E. Every reply
    // containing a semicolon was silently cleared — under-counting, so the corpus score
    // never moved. U+037E decomposes to U+003B under NFC, so the glyph could not have
    // survived here anyway; both are simply absent now.
    expect(looksLikeDroppedQuestions('I have everything; building it now!')).toBe(true);
    // And the Greek gap is real rather than covered: modern Greek types U+003B.
    expect(looksLikeDroppedQuestions('Τι θέλετε να παρακολουθείτε;')).toBe(true);
  });

  it.each([
    ['circled U+2460', 'Tell me:\n① the metric\n② the range'],
    ['parenthesised U+2474', 'Tell me:\n⑴ the metric\n⑵ the range'],
    ['digit-with-full-stop U+2488', 'Tell me:\n⒈ the metric\n⒉ the range'],
    ['dingbat circled U+2776', 'Tell me:\n❶ the metric\n❷ the range'],
  ])('enclosed numerals still mark a list: %s', (_label, reply) => {
    expect(looksLikeDroppedQuestions(reply)).toBe(false);
  });

  it.each([
    ['a vulgar fraction enumerates nothing', '½ of the fleet is already reporting!'],
    ['a superscript enumerates nothing', '² is the exponent I applied to the series.'],
  ])('but the rest of \\p{No} does not: %s', (_label, reply) => {
    // The one narrowing in the whole rule, so it is the one change that can ADD a flag:
    // under `\p{No}` these two opened a list and cleared the turn. Neither enumerates.
    expect(looksLikeDroppedQuestions(reply)).toBe(true);
  });
});

/**
 * MR !67 review — the logging contract, executable.
 *
 * The DECISION behind the two log lines needs no AWS, so it lives here as a pure function
 * and is pinned below: which turns contribute to the rate, which are omitted entirely, and
 * what the warn may carry. That `logger.info` and `logger.warn` are the calls actually
 * made is a separate question about wiring, and round 2 of the review was right that
 * nothing covered it — `bedrockAgent.logging.test.ts` now does.
 */
describe('droppedQuestionsTelemetry (DO-380 logging contract)', () => {
  const question = (message: string): AgentIntent => ({
    type: 'question',
    message,
    via: 'heuristic',
  });

  /** Stands in for whatever the agent quoted back from the user's request. */
  const SECRET = 'ACME-Logistics-fleet-42';

  it('an eligible healthy turn records the DENOMINATOR: false plus a length', () => {
    // The whole reason the verdict rides the every-turn info line. Without a `false`
    // here a query yields a count of failures over an unknown total — which is the
    // question the agent's author asked us to answer.
    // The 47-char healthy control from the corpus — the one that defeats every length
    // threshold. It has to land in the denominator, not be dropped as "too short".
    const prose = 'What would you like to track on your dashboard?';
    expect(droppedQuestionsTelemetry(question(prose), prose)).toEqual({
      info: { questionsDropped: false, replyChars: 47 },
      warn: null,
    });
  });

  it('an eligible failing turn records the NUMERATOR and one text-free warn', () => {
    const prose = "I'm ready to build as soon as I have those details!";
    expect(droppedQuestionsTelemetry(question(prose), prose)).toEqual({
      info: { questionsDropped: true, replyChars: 51 },
      warn: { replyChars: 51 },
    });
  });

  it('OMITS the fields on a result turn rather than recording false', () => {
    // A build turn legitimately asks nothing. Recording `false` would put it in the
    // denominator and understate the rate; recording `true` would invent a failure.
    const prose = 'Your dashboard is ready: s3://bucket/report_schema.json';
    const intent = interpretAgentResponse(prose);
    expect(intent.type).toBe('result');
    expect(droppedQuestionsTelemetry(intent, prose)).toEqual({ info: {}, warn: null });
  });

  it('OMITS the fields on a POSSIBLE_MISSED_RESULT turn — a different defect', () => {
    // Classifies as 'question' and asks nothing, so it would score true on the rule.
    // It is a build reply that lost its URL: counting it contaminates the numerator of
    // the very rate the fix will be sized from. Delete this gate and that happens
    // silently, which is why the assertion is on {} and not on questionsDropped.
    const prose = 'Your dashboard has been built and is being uploaded now.';
    const intent = interpretAgentResponse(prose);
    expect(intent.type).toBe('question');
    expect(looksLikeDroppedQuestions(prose)).toBe(true);
    expect(droppedQuestionsTelemetry(intent, prose)).toEqual({ info: {}, warn: null });
  });

  it('carries NO agent text in any payload, and measures the DELIVERED reply', () => {
    // MR !67 review round 2. Round 1 shipped a 400-char preview here; agent prose quotes
    // the user's request back, so that copied tenant data into CloudWatch on a condition
    // that fires on roughly one question turn in twelve. The whole payload is numbers now,
    // and this asserts it structurally rather than by naming the key that used to exist —
    // any future field carrying a fragment of the reply fails here.
    //
    // `message` is what the user saw; `prose` is what arrived. Identical under today's
    // heuristic, so a trailer intent forces them apart: the day §3.4.4 lands, replyChars
    // must count the reply and not the machinery.
    const message = `Ready when you send those details, ${SECRET}!`;
    const prose = `${message}\n\`\`\`json\n{"type":"question"}\n\`\`\``;
    const telemetry = droppedQuestionsTelemetry(
      { type: 'question', message, via: 'trailer' },
      prose,
    );

    expect(telemetry.info).toEqual({ questionsDropped: true, replyChars: message.length });
    expect(telemetry.warn).toEqual({ replyChars: message.length });

    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain(SECRET);
    // Nothing lifted from the reply at all, not merely the marker: every leaf is a number
    // or a boolean, so no wording can reach a log through this helper.
    for (const payload of [telemetry.info, telemetry.warn ?? {}]) {
      for (const value of Object.values(payload)) {
        expect(typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });

  it('is total: an empty reply produces a verdict rather than throwing', () => {
    // Not a reachable state — collectCompletion throws EmptyCompletion on a
    // whitespace-only drain — but nothing in the signature says the caller pre-filters.
    expect(droppedQuestionsTelemetry(question(''), '')).toEqual({
      info: { questionsDropped: true, replyChars: 0 },
      warn: { replyChars: 0 },
    });
  });
});

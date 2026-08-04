import { describe, it, expect } from '@jest/globals';
import {
  interpretAgentResponse,
  looksLikeDroppedQuestions,
  looksLikeMissedResult,
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
 * publicly, so the five non-English captures live in DO-380 rather than here. Nothing
 * is lost: the rule tests for a question mark and a list marker, so it has no language
 * dependency to pin — and the defect is NOT language-specific, which is precisely what
 * the English control below establishes. (An earlier report claimed it was; the larger
 * sample disproved that.)
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

  it('is not ASCII-dependent: a non-English sign-off with no question still flags', () => {
    // Stands in for the five non-English captures in DO-380. Multi-byte characters
    // and emoji must not perturb either test — the failure rate on the non-English
    // path measured ~4x the English one, so this path carries most of the volume.
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

  it('overlaps looksLikeMissedResult, which is why the caller excludes it', () => {
    // A build reply that lost its URL asks nothing, so it scores true on BOTH — yet it
    // is POSSIBLE_MISSED_RESULT, a different defect. The predicates cannot tell them
    // apart and are not meant to: the CALLER records a verdict only when
    // `type === 'question' && !looksLikeMissedResult(prose)`, so this turn leaves both
    // sides of the rate. Drop that gate and the numerator silently absorbs reworded
    // build replies.
    const missedBuild = 'Your dashboard has been built and is being uploaded now.';
    expect(looksLikeMissedResult(missedBuild)).toBe(true);
    expect(looksLikeDroppedQuestions(missedBuild)).toBe(true);

    // The genuine defect carries no build marker, so the caller's gate lets it through.
    const droppedInterview = "I'm ready to build as soon as I have those details!";
    expect(looksLikeMissedResult(droppedInterview)).toBe(false);
    expect(looksLikeDroppedQuestions(droppedInterview)).toBe(true);
  });
});

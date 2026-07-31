import { describe, it, expect } from '@jest/globals';
import {
  RESULT_FALLBACK_MESSAGE,
  stripArtifactUrls,
  withoutArtifactUrls,
} from '../stripArtifactUrl.js';
import { interpretAgentResponse } from '../interpretResponse.js';
import { toDashboardResult } from '../bedrockAgent.js';
import type { AgentTurn } from '../types.js';

/**
 * Bucket and job id are PLACEHOLDERS, deliberately. The shapes below mirror real
 * observed replies, but this repo is mirrored publicly and real bucket names are
 * infrastructure — the point of this module is not to publish them.
 */
const BUCKET = 'example-dashboard-artifacts-0000';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const URL = `s3://${BUCKET}/jobs/${JOB_ID}/report_schema.json`;

/** The current build reply: a details TABLE plus an `aws s3 cp` FENCE with a
 *  colon-terminated lead-in. Shape as measured 2026-07-30; wording is not a
 *  contract and the module keys on the URL, never on the words. */
const TABLE_AND_FENCE_REPLY = [
  'Your **Driver Mileage** dashboard has been built and uploaded successfully! 🎉',
  '',
  "Here's a summary of what was generated:",
  '',
  '- **📊 Panel 1 — Bar Chart:** *Total Mileage by Driver (km)*',
  '- **📋 Panel 2 — Table:** *Driver Mileage Ranking (km)*',
  '',
  '---',
  '',
  '**📦 Build Details:**',
  '',
  '| Field | Value |',
  '|---|---|',
  `| **Job ID** | \`${JOB_ID}\` |`,
  `| **Download URL** | \`${URL}\` |`,
  '',
  'To download the report schema locally, you can run:',
  '```bash',
  `aws s3 cp ${URL} ./report_schema.json`,
  '```',
  '',
  "Let me know if you'd like to add more panels, adjust filters, or create a new dashboard!",
].join('\n');

/** The earlier shape: a bullet LABEL with the URL on the line below it. */
const LABEL_AND_LINE_REPLY = [
  'Your dashboard has been built and saved successfully! 🎉',
  '',
  '- 📊 Title: Vehicle Mileage by Driver — Last 30 Days',
  `- 🆔 Job ID: \`${JOB_ID}\``,
  '- 📥 Download URL:',
  `\`${URL}\``,
  '',
  'You can preview it against your data and apply it when ready.',
].join('\n');

describe('stripArtifactUrls', () => {
  it('removes the URL, its table row, and the whole aws-cp fence with its lead-in', () => {
    const out = stripArtifactUrls(TABLE_AND_FENCE_REPLY);

    expect(out).not.toContain('s3://');
    expect(out).not.toContain(BUCKET);
    expect(out).not.toContain('Download URL');
    expect(out).not.toContain('aws s3 cp');
    expect(out).not.toContain('```');
    expect(out).not.toContain('To download the report schema locally');

    // Everything that was not about the URL survives.
    expect(out).toContain('built and uploaded successfully');
    expect(out).toContain('Panel 1 — Bar Chart');
    expect(out).toContain("Let me know if you'd like to add more panels");
    // The job id is deliberate — the agent's author added it on request, and it
    // is the handle for a support conversation. Only the URL is infrastructure.
    expect(out).toContain(JOB_ID);
    // The table keeps its header, delimiter and surviving row: still valid.
    expect(out).toContain('| Field | Value |');
    expect(out).toContain(`| **Job ID** | \`${JOB_ID}\` |`);
  });

  it('removes a bullet label whose only content was the URL on the next line', () => {
    const out = stripArtifactUrls(LABEL_AND_LINE_REPLY);

    expect(out).not.toContain('s3://');
    expect(out).not.toContain('Download URL');
    expect(out).toContain('- 📊 Title: Vehicle Mileage by Driver');
    expect(out).toContain(`- 🆔 Job ID: \`${JOB_ID}\``);
    expect(out).toContain('You can preview it against your data');
  });

  it('leaves no empty husk where the wrapper was', () => {
    for (const wrapped of [
      `| **Download URL** | \`${URL}\` |`,
      `See \`${URL}\` for the file.`,
      `Download it [here](${URL}).`,
      `Download it [here]( ${URL} ).`,
    ]) {
      const out = stripArtifactUrls(wrapped);
      expect(out).not.toMatch(/``/);
      expect(out).not.toMatch(/\[[^\]]*\]\(\s*\)/);
      expect(out).not.toContain('s3://');
    }
  });

  it('keeps a sentence that said more than the URL, closing the gap it left', () => {
    const out = stripArtifactUrls(`Your dashboard is ready at ${URL} — apply it when you like.`);
    expect(out).not.toContain('s3://');
    expect(out).toContain('Your dashboard is ready at');
    expect(out).toContain('apply it when you like.');
    expect(out).not.toMatch(/ {2}/);
  });

  it('returns prose with no URL byte-identical — a clean reply is never reflowed', () => {
    for (const clean of [
      '',
      '   \n\n  ',
      'Which vehicles should this cover?\n\n\n1. All of them\n2. One depot\n',
      'Nothing to strip here.',
    ]) {
      expect(stripArtifactUrls(clean)).toBe(clean);
    }
  });

  it('removes every URL, not just the first', () => {
    const second = `s3://${BUCKET}/jobs/99999999-8888-4777-8666-555555555555/report_schema.json`;
    const out = stripArtifactUrls(
      [`Primary: \`${URL}\``, `Backup: \`${second}\``, 'Both are ready.'].join('\n'),
    );
    expect(out).not.toContain('s3://');
    expect(out).toBe('Both are ready.');
  });

  it('takes an unterminated fence to the end rather than let the URL survive', () => {
    const out = stripArtifactUrls(['Run this:', '```bash', `aws s3 cp ${URL} .`].join('\n'));
    expect(out).not.toContain('s3://');
    expect(out).not.toContain('```');
    expect(out).toBe('');
  });

  it('takes the header, delimiter and caption when the URL was the only body row', () => {
    const out = stripArtifactUrls(
      [
        '**📦 Build Details:**',
        '',
        '| Field | Value |',
        '|---|---|',
        `| **Download URL** | \`${URL}\` |`,
        '',
        'Done!',
      ].join('\n'),
    );
    expect(out).toBe('Done!');
  });

  it('opens no gap the prose did not have', () => {
    for (const reply of [TABLE_AND_FENCE_REPLY, LABEL_AND_LINE_REPLY]) {
      const out = stripArtifactUrls(reply);
      expect(out).not.toMatch(/\n{3}/);
      expect(out).not.toMatch(/^\s|\s$/);
      expect(out).not.toMatch(/[ \t]+$/m);
    }
  });

  it('removes an INLINE copy command rather than publish it mutilated', () => {
    // ROUND 16, Minor. Excising the URL from the middle of a sentence that WAS
    // the command left `Run aws s3 cp ./report_schema.json` on screen: a command
    // with its source argument deleted, which the reader cannot run and cannot
    // repair. The line went to advertise the copy, so the line goes.
    const out = stripArtifactUrls(
      `Your dashboard is built. Run aws s3 cp ${URL} ./report_schema.json to download it.`,
    );

    expect(out).not.toContain('aws s3 cp');
    expect(out).not.toContain('report_schema.json');
    expect(out).not.toContain('s3://');
    expect(out).toBe('');
  });

  it('removes a copy-command fence written against a PLACEHOLDER', () => {
    // ROUND 16, Minor. The fence rule keyed on a literal s3:// INSIDE the fence,
    // so this shape — real URL in the table above, placeholder in the command —
    // survived whole, and the chat renderer parses no fences: the user saw the
    // backticks too.
    const out = stripArtifactUrls(
      [
        'Your dashboard is ready.',
        '',
        `- Download URL: \`${URL}\``,
        '',
        'To fetch it, substitute the URL above:',
        '```bash',
        'aws s3 cp ARTIFACT_URL ./report_schema.json',
        '```',
      ].join('\n'),
    );

    expect(out).toBe('Your dashboard is ready.');
    expect(out).not.toContain('```');
    expect(out).not.toContain('aws s3');
    expect(out).not.toContain('ARTIFACT_URL');
  });

  it('recognises the command in the other shapes the agent writes it in', () => {
    for (const command of [
      `aws s3 cp ${URL} .`,
      'aws s3 cp <ARTIFACT_URL> ./report_schema.json',
      '$ aws  s3   cp ARTIFACT_URL ./out.json',
      'aws s3api get-object --bucket example-dashboard-artifacts-0000 --key jobs/x.json out.json',
    ]) {
      const out = stripArtifactUrls([`Download URL: \`${URL}\``, command].join('\n'));
      expect(out).toBe('');
    }
  });

  it('leaves a URL-FREE reply alone even when it mentions the AWS CLI', () => {
    // The deliberate boundary of the command rule. The entry guard is still "this
    // prose carries an s3:// URL", which is what makes it safe to run this over
    // every assistant turn: nothing leaks from a reply with no URL in it, and a
    // question turn that discusses `aws s3 cp` is the user's answer, not our husk.
    const clean = 'You would normally use `aws s3 cp` for that, but I have the file already.';
    expect(stripArtifactUrls(clean)).toBe(clean);
  });

  it('leaves nothing the classifier can still see — the twin regexes agree', () => {
    // interpretAgentResponse is the oracle: it classifies as 'result' exactly
    // when it finds an s3:// URL. If a stripped reply still reads as a result,
    // this module's URL pattern has drifted from the classifier's.
    for (const reply of [
      TABLE_AND_FENCE_REPLY,
      LABEL_AND_LINE_REPLY,
      `bare ${URL} in prose`,
      `bracketed [${URL}] in prose`,
      `quoted "${URL}" in prose`,
      `parenthesised (${URL}) in prose`,
      `sentence-final ${URL}.`,
    ]) {
      expect(interpretAgentResponse(reply).type).toBe('result');
      expect(interpretAgentResponse(stripArtifactUrls(reply)).type).toBe('question');
    }
  });
});

/**
 * ROUND 16, Important — the READ side. Stripping on write only ever protected
 * turns written after it shipped; a transcript saved before it (or by an old
 * replica mid-rollout) is stored verbatim and re-published in full on the next
 * page load. This is the pass that catches those, and the rows stay untouched.
 */
describe('withoutArtifactUrls — a transcript on its way back to the browser', () => {
  const dashboard = { title: 'Fleet Overview', report_schema: { title: 'Fleet Overview' } };
  const savedResult = (content: string): AgentTurn => ({
    role: 'assistant', type: 'result', content, result: dashboard,
  });

  it('cleans a result turn saved before the sanitizer existed, preview intact', () => {
    const [turn] = withoutArtifactUrls([savedResult(TABLE_AND_FENCE_REPLY)]);

    expect(turn.content).not.toContain('s3://');
    expect(turn.content).not.toContain(BUCKET);
    expect(turn.content).not.toContain('Download URL');
    expect(turn.content).not.toContain('aws s3 cp');
    expect(turn.content).not.toContain('```');
    // What the turn was FOR survives: the prose and the dashboard behind Preview.
    expect(turn.content).toContain('built and uploaded successfully');
    expect(turn.content).toContain('Panel 1 — Bar Chart');
    expect(turn.result).toBe(dashboard);
    expect(turn.type).toBe('result');
  });

  it('words an emptied turn exactly as the live turn did — no drift between the two', () => {
    // toDashboardResult is the oracle: the same reply stripped on the way in and
    // on the way out must produce the same bubble, or a reload silently reworded
    // the conversation. One constant, asserted from both ends.
    const proseThatWasOnlyTheUrl = `\`${URL}\``;
    const [turn] = withoutArtifactUrls([savedResult(proseThatWasOnlyTheUrl)]);

    expect(turn.content).toBe(
      toDashboardResult(proseThatWasOnlyTheUrl, { title: 'Fleet Overview' }).message,
    );
    expect(turn.content).toBe(RESULT_FALLBACK_MESSAGE);
  });

  it('never edits what the USER typed, URL and all', () => {
    // Their words are theirs. A transcript that quietly rewrites them is a
    // transcript that lies — and there is nothing of ours to leak in one.
    const typed = `can you read ${URL} for me?`;
    const [turn] = withoutArtifactUrls([{ role: 'user', content: typed }]);

    expect(turn.content).toBe(typed);
  });

  it('cleans a legacy assistant row that carries a URL without a result payload', () => {
    // rowToTurn maps a type-NULL row onto plain assistant prose. Such a row cannot
    // be produced today, but a read-side backstop is exactly where that kind of
    // thing belongs.
    const [turn] = withoutArtifactUrls([
      { role: 'assistant', content: `Here it is: \`${URL}\` — enjoy.` },
    ]);

    expect(turn.content).not.toContain('s3://');
    expect(turn.content).toContain('Here it is:');
    expect(turn.content).toContain('enjoy');
  });

  it('promises no dashboard on an arm that has none, even stripped to nothing', () => {
    // The fallback sentence belongs to the result arm, where a payload makes it
    // true. Reaching for it here would invent a dashboard the turn cannot preview.
    const [turn] = withoutArtifactUrls([{ role: 'assistant', content: `\`${URL}\`` }]);

    expect(turn.content).toBe('');
    expect(turn.content).not.toBe(RESULT_FALLBACK_MESSAGE);
  });

  it('returns a clean transcript BY REFERENCE — the common path rewrites nothing', () => {
    const history: AgentTurn[] = [
      { role: 'user', content: 'build me a mileage dashboard' },
      { role: 'assistant', type: 'question', content: 'Which time range?', result: null },
      savedResult('Built it! 🎉'),
    ];

    const out = withoutArtifactUrls(history);

    expect(out).toBe(history);
    expect(out[2]).toBe(history[2]);
  });

  it('leaves the turns it did not have to touch alone, by reference', () => {
    const clean: AgentTurn = { role: 'user', content: 'and now by depot?' };
    const dirty = savedResult(`Done — \`${URL}\``);

    const out = withoutArtifactUrls([clean, dirty]);

    expect(out[0]).toBe(clean);
    expect(out[1]).not.toBe(dirty);
    expect(dirty.content).toContain('s3://'); // the input is not mutated
  });
});

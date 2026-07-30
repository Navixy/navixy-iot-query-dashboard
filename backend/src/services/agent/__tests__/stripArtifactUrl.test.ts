import { describe, it, expect } from '@jest/globals';
import { stripArtifactUrls } from '../stripArtifactUrl.js';
import { interpretAgentResponse } from '../interpretResponse.js';

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

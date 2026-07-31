import { describe, it, expect, afterEach } from '@jest/globals';
import { validateChatBody, buildSessionResponse, MAX_MESSAGE_LENGTH } from '../agent.js';
import type { AgentTurn } from '../../services/agent/types.js';
import {
  appendTurns, loadHistory, __resetChatStoreForTests,
} from '../../services/agent/chatStore.js';
import { CustomError } from '../../middleware/errorHandler.js';

// validateChatBody is exported pure precisely so the 400 taxonomy is testable
// without supertest (which this MR does not add). The route itself — session
// resolution, persistence, the deadline, the validateDashboard gate — is covered
// by chatStore.memory.test.ts (session contract) and the MR's manual curl matrix.

function expect400(body: unknown, messagePart: string): void {
  try {
    validateChatBody(body);
    throw new Error(`expected validateChatBody to throw for ${JSON.stringify(body)}`);
  } catch (err) {
    expect(err).toBeInstanceOf(CustomError);
    expect((err as CustomError).statusCode).toBe(400); // 400 < 500 → message survives errorHandler (C7)
    expect((err as CustomError).message).toContain(messagePart);
  }
}

describe('validateChatBody — the ONLY things that 400 (§3.2)', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'hello'],
    ['a number', 42],
    ['an array', [{ message: 'hi' }]],
  ])('rejects a body that is %s', (_label, body) => {
    expect400(body, 'JSON object');
  });

  it('rejects a missing message', () => {
    expect400({}, 'message is required');
    expect400({ session_id: null }, 'message is required');
    expect400({ message: null }, 'message is required');
  });

  it.each([
    ['a number', 7],
    ['an object', { text: 'hi' }],
    ['an array', ['hi']],
    ['a boolean', true],
  ])('rejects a message that is %s', (_label, message) => {
    expect400({ message }, 'message must be a string');
  });

  it('rejects a message that is empty after trim', () => {
    expect400({ message: '' }, 'must not be empty');
    expect400({ message: '   \n\t  ' }, 'must not be empty');
  });

  it(`rejects a message over ${MAX_MESSAGE_LENGTH} chars and accepts one exactly at the limit`, () => {
    expect400({ message: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) }, 'at most');
    expect(validateChatBody({ message: 'a'.repeat(MAX_MESSAGE_LENGTH), client_turn_id: 't' })).toEqual({
      session_id: null,
      message: 'a'.repeat(MAX_MESSAGE_LENGTH),
      client_turn_id: 't',
    });
  });

  it('measures the limit AFTER trimming — padding does not count against the user', () => {
    const padded = `  ${'a'.repeat(MAX_MESSAGE_LENGTH)}  `;
    expect(validateChatBody({ message: padded, client_turn_id: 't' }).message).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it.each([
    ['a number', 123],
    ['an object', { id: 'x' }],
    ['an array', ['x']],
    ['a boolean', false],
  ])('rejects a session_id that is %s', (_label, session_id) => {
    expect400({ session_id, message: 'hi' }, 'session_id must be a string');
  });

  it('normalizes an absent or null session_id to null', () => {
    expect(validateChatBody({ message: 'hi', client_turn_id: 't' })).toEqual({
      session_id: null,
      message: 'hi',
      client_turn_id: 't',
    });
    expect(validateChatBody({ session_id: null, message: 'hi', client_turn_id: 't' })).toEqual({
      session_id: null,
      message: 'hi',
      client_turn_id: 't',
    });
  });

  it('round-trips a valid body with the message trimmed', () => {
    expect(validateChatBody({ session_id: 'abc-123', message: '  build me a dashboard  ', client_turn_id: 't' })).toEqual({
      session_id: 'abc-123',
      message: 'build me a dashboard',
      client_turn_id: 't',
    });
  });

  it('passes an arbitrary session_id STRING through untouched — resolution is the store\'s job (D13), never a 400', () => {
    expect(validateChatBody({ session_id: 'not-a-real-session', message: 'hi', client_turn_id: 't' }).session_id).toBe(
      'not-a-real-session',
    );
  });

  it('pins MAX_MESSAGE_LENGTH at 4000 — MR 5\'s composer mirrors this constant', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(4_000);
  });

  // client_turn_id (review !62 round 6): the idempotency id the client mints per send.
  describe('client_turn_id', () => {
    it('round-trips a valid client_turn_id untouched', () => {
      expect(
        validateChatBody({ message: 'hi', client_turn_id: '5f1e-abc' }).client_turn_id,
      ).toBe('5f1e-abc');
    });

    it('REQUIRES an id — absent, null and empty are all 400s (round 11, Important 2)', () => {
      // It was optional, and an absent id meant no receipt was written, which left
      // the single-active-turn guard with nothing to see: a second concurrent
      // request was simply admitted. The guard's state IS the receipt.
      expect400({ message: 'hi' }, 'client_turn_id is required');
      expect400({ message: 'hi', client_turn_id: null }, 'client_turn_id is required');
      expect400({ message: 'hi', client_turn_id: '' }, 'client_turn_id is required');
    });

    it.each([
      ['a number', 123],
      ['an object', { id: 'x' }],
      ['an array', ['x']],
      ['a boolean', true],
    ])('rejects a client_turn_id that is %s', (_label, client_turn_id) => {
      expect400({ message: 'hi', client_turn_id }, 'client_turn_id is required');
    });

    it('rejects a client_turn_id over 100 chars and accepts one at the limit', () => {
      expect400({ message: 'hi', client_turn_id: 'a'.repeat(101) }, 'at most');
      expect(
        validateChatBody({ message: 'hi', client_turn_id: 'a'.repeat(100) }).client_turn_id,
      ).toHaveLength(100);
    });

    it('does NOT require a UUID shape — the server only stores and echoes it', () => {
      expect(validateChatBody({ message: 'hi', client_turn_id: 'not-a-uuid' }).client_turn_id).toBe(
        'not-a-uuid',
      );
    });
  });
});

/**
 * review !62 round 13, Important 1. The store can now answer "I could not
 * determine that" (undefined), and the wire body has to carry that distinction as
 * ABSENCE. Serializing it as `awaiting_reply: false` is the bug: the client takes
 * any boolean as the server's final word and stops deriving the state from the
 * transcript, so a tenant with no usable receipts table — whose server-side guard
 * is off for exactly the same reason — loses its last guard too.
 */
describe('buildSessionResponse — awaiting_reply is OMITTED when unknown', () => {
  const base = {
    sessionId: 'sess-1',
    history: [] as AgentTurn[],
    persisted: true,
    supportsTurnIds: true,
  };

  it('OMITS the key entirely when the store could not determine it', () => {
    const body = buildSessionResponse({ ...base });

    expect('awaiting_reply' in body).toBe(false);
    expect(body.awaiting_reply).toBeUndefined();
    // JSON.stringify drops an undefined value, but an explicit `false` would
    // survive it — assert on the serialized body, since that is what ships.
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty('awaiting_reply');
  });

  it('sends false when the store actually PROVED the session idle', () => {
    const body = buildSessionResponse({ ...base, awaitingReply: false });

    expect('awaiting_reply' in body).toBe(true);
    expect(body.awaiting_reply).toBe(false);
  });

  it('sends true when a turn is still running', () => {
    expect(buildSessionResponse({ ...base, awaitingReply: true }).awaiting_reply).toBe(true);
  });

  it('passes the rest of the store result through unchanged', () => {
    const history: AgentTurn[] = [{ role: 'user', content: 'hi' }];
    const body = buildSessionResponse({
      sessionId: 'sess-9', history, persisted: false, supportsTurnIds: false,
    });

    expect(body).toEqual({
      session_id: 'sess-9', persisted: false, supports_turn_ids: false, messages: history,
    });
  });
});

/**
 * review !62 round 16, Important — the artifact URL must not come back on reload.
 *
 * The sanitizer ran only where a turn was BUILT, so it protected nothing already
 * written: rowToTurn hands a stored row back as `content: row.content`, and every
 * transcript saved before it shipped — plus every reply an old replica writes
 * during a rolling deploy — put the internal bucket back on screen at the next
 * page load. GET /session's body builder is where that is closed, because it is
 * the one place both stores become the wire.
 *
 * Bucket and job id are PLACEHOLDERS: this repo is mirrored publicly.
 */
describe('buildSessionResponse — a transcript saved before the sanitizer existed', () => {
  const BUCKET = 'example-dashboard-artifacts-0000';
  const JOB_ID = '11111111-2222-4333-8444-555555555555';
  const URL = `s3://${BUCKET}/jobs/${JOB_ID}/report_schema.json`;
  const dashboard = { title: 'Driver Mileage', report_schema: { title: 'Driver Mileage' } };

  /** Exactly what the pre-round-16 code persisted: the agent's reply verbatim. */
  const STORED_REPLY = [
    'Your **Driver Mileage** dashboard has been built and uploaded successfully! 🎉',
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
  ].join('\n');

  const stored: AgentTurn[] = [
    { role: 'user', content: 'build me a driver mileage dashboard' },
    { role: 'assistant', type: 'result', content: STORED_REPLY, result: dashboard },
  ];

  it('serves it with no URL, no bucket and no husks — and the preview still works', () => {
    const body = buildSessionResponse({
      sessionId: 'sess-1', history: stored, persisted: true, supportsTurnIds: true,
    });
    const wire = JSON.stringify(body);
    const reply = body.messages[1];

    expect(wire).not.toContain('s3://');
    expect(wire).not.toContain(BUCKET);
    expect(reply.content).not.toContain('Download URL');
    expect(reply.content).not.toContain('aws s3 cp');
    expect(reply.content).not.toContain('```');
    // The husks the URL left behind are gone too, not just the URL.
    expect(reply.content).not.toContain('| **Download URL** |');
    expect(reply.content).not.toContain('To download the report schema locally');

    // Everything the turn was FOR survives.
    expect(reply.content).toContain('built and uploaded successfully');
    expect(reply.content).toContain(JOB_ID); // the support handle stays
    expect(reply.result).toEqual(dashboard); // Preview and Apply still have it
    expect(body.messages[0]).toEqual(stored[0]); // the user's own words, untouched
  });

  it('does not touch the stored turns — nothing is migrated or rewritten in place', () => {
    buildSessionResponse({
      sessionId: 'sess-1', history: stored, persisted: true, supportsTurnIds: true,
    });

    // The row keeps the agent's own words. Whatever this rule becomes later, the
    // record it was applied to is still there to apply it to.
    expect(stored[1].content).toBe(STORED_REPLY);
    expect(stored[1].content).toContain(URL);
  });
});

/**
 * The same leak through the DEGRADED store (round 16, Important). A tenant that
 * has not applied 002 keeps its transcript in the process buffer, which the same
 * builder serializes — so the fix has to hold on a path that never sees Postgres.
 */
describe('GET /session body from the in-memory store', () => {
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it('is clean even though the buffer still holds the agent\'s raw words', async () => {
    const URL = 's3://example-dashboard-artifacts-0000/jobs/'
      + '11111111-2222-4333-8444-555555555555/report_schema.json';
    const ident = { tenantKey: 'tenant-1', userId: 'u1', demo: false };
    const { sessionId } = await loadHistory(null, ident, null);

    // Written the way a pre-round-16 backend wrote it: prose straight through.
    await appendTurns(null, ident, sessionId, [
      { role: 'user', content: 'build it' },
      {
        role: 'assistant',
        type: 'result',
        content: ['Done!', '', `Download URL: \`${URL}\``].join('\n'),
        result: { title: 'D', report_schema: { title: 'D' } },
      },
    ]);

    const stored = await loadHistory(null, ident, null);
    expect(stored.persisted).toBe(false);
    expect(stored.history[1].content).toContain('s3://'); // the store is unchanged...

    const body = buildSessionResponse(stored);
    expect(JSON.stringify(body)).not.toContain('s3://'); // ...the wire is not
    expect(body.messages[1].content).toBe('Done!');
    expect(body.messages[1].result).toEqual({ title: 'D', report_schema: { title: 'D' } });
  });
});

import { describe, it, expect } from '@jest/globals';
import { validateChatBody, MAX_MESSAGE_LENGTH } from '../agent.js';
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
    expect(validateChatBody({ message: 'a'.repeat(MAX_MESSAGE_LENGTH) })).toEqual({
      session_id: null,
      message: 'a'.repeat(MAX_MESSAGE_LENGTH),
    });
  });

  it('measures the limit AFTER trimming — padding does not count against the user', () => {
    const padded = `  ${'a'.repeat(MAX_MESSAGE_LENGTH)}  `;
    expect(validateChatBody({ message: padded }).message).toHaveLength(MAX_MESSAGE_LENGTH);
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
    expect(validateChatBody({ message: 'hi' })).toEqual({ session_id: null, message: 'hi' });
    expect(validateChatBody({ session_id: null, message: 'hi' })).toEqual({
      session_id: null,
      message: 'hi',
    });
  });

  it('round-trips a valid body with the message trimmed', () => {
    expect(validateChatBody({ session_id: 'abc-123', message: '  build me a dashboard  ' })).toEqual({
      session_id: 'abc-123',
      message: 'build me a dashboard',
    });
  });

  it('passes an arbitrary session_id STRING through untouched — resolution is the store\'s job (D13), never a 400', () => {
    expect(validateChatBody({ session_id: 'not-a-real-session', message: 'hi' }).session_id).toBe(
      'not-a-real-session',
    );
  });

  it('pins MAX_MESSAGE_LENGTH at 4000 — MR 5\'s composer mirrors this constant', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(4_000);
  });
});

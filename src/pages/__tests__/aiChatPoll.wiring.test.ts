/**
 * review !62 round 14, Important 1 — SOURCE-LEVEL, and deliberately so.
 *
 * The rule itself (shouldPollSession) and the release it feeds (useAwaitingReplyLock)
 * are unit-tested where they live. What those tests cannot see is whether AiChat
 * actually ASKS: the page is a 700-line route with a router, an auth context, a
 * query client and the api module behind it, and this repo has no render harness
 * for it. So this asserts the wiring by reading the source — narrow, but it fails
 * loudly if the mount-local lock is ever dropped from the poll condition again,
 * which is exactly the regression that made the round-13 lock unreleasable.
 *
 * If a render test for AiChat ever lands, delete this file rather than keep both.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../AiChat.tsx', import.meta.url)),
  'utf8',
);

describe('AiChat polls while a mount-local lock is held', () => {
  it('gates the poll on the shared rule, not on the server verdict alone', () => {
    expect(source).toContain('shouldPollSession(serverAwaitingReply, awaitingServerReply)');
  });

  it('re-runs the poll effect when the mount-local lock changes', () => {
    // Without the lock in the dependency array the effect keeps the stale closure
    // and never starts polling when the lock is taken.
    expect(source).toContain('[serverAwaitingReply, awaitingServerReply, refetchSession]');
  });

  it('records every successful reconciliation GET as an observation', () => {
    // The reconciler's own polls are readings too. If they are not recorded, the
    // lock taken after them measures itself against a stale baseline and the very
    // response that justified it can turn around and release it.
    expect(source).toContain('recordSessionObservation(response.data)');
  });

  it('locks with the failed turn id so the identity release can apply', () => {
    expect(source).toContain('lockAwaitingServerReply(failed.clientTurnId)');
  });
});

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { logger } from '../../../utils/logger.js';
import { loadHistory, appendTurns, __resetChatStoreForTests } from '../chatStore.js';
import type { AgentChatResult, AgentTurn } from '../types.js';

// The in-memory fallback path — no database anywhere. The single Postgres-path
// assertion that IS unit-testable (the failure contract: a rejecting pool must
// DEGRADE, never reject) runs against an injected stub pool; the happy Postgres
// path and its SQL are covered by the MR's manual M-PERSIST check instead.

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 2 * 60 * 60 * 1000;

/** The REAL artifact the live agent produced on 2026-07-20 (vendored by MR 3). */
const PROBE_ARTIFACT_PATH = fileURLToPath(new URL('./fixtures/artifact.json', import.meta.url));

const user = (content: string): AgentTurn => ({ role: 'user', content });
const question = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});

afterEach(() => {
  __resetChatStoreForTests();
  jest.restoreAllMocks();
});

describe('chatStore — in-memory fallback', () => {
  it('round-trips turns in order and reports persisted: false', async () => {
    const { sessionId, history, persisted } = await loadHistory(null, 'u1', null);
    expect(persisted).toBe(false);
    expect(history).toEqual([]);
    expect(sessionId).toMatch(UUID_SHAPE);

    const turns: AgentTurn[] = [
      user('build me a mileage dashboard'),
      question('Which time range?'),
      user('last 7 days'),
      question('Which vehicles?'),
    ];
    await appendTurns(null, 'u1', sessionId, [turns[0]]);
    await appendTurns(null, 'u1', sessionId, [turns[1]]);
    await appendTurns(null, 'u1', sessionId, [turns[2], turns[3]]);

    const reloaded = await loadHistory(null, 'u1', sessionId);
    expect(reloaded.sessionId).toBe(sessionId);
    expect(reloaded.persisted).toBe(false);
    expect(reloaded.history).toEqual(turns);
  });

  it('yields a live session for an unknown session_id instead of throwing (D13)', async () => {
    const first = await loadHistory(null, 'u1', 'not-a-real-session');
    expect(first.sessionId).toMatch(UUID_SHAPE);
    expect(first.sessionId).not.toBe('not-a-real-session');

    // The server is authoritative: a SECOND bogus id resolves to the user's single
    // active session (D7), not to another fresh one.
    const second = await loadHistory(null, 'u1', 'another-bogus-id');
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('two concurrent turn-1 calls yield one session, not two', async () => {
    // No await between the map lookup and the insert — the resolve-or-create runs in
    // one synchronous tick, so both concurrent calls land on the same session.
    const [a, b] = await Promise.all([
      loadHistory(null, 'race-user', null),
      loadHistory(null, 'race-user', null),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
  });

  it('caps a session at MAX_TURNS = 100 by dropping oldest — the COUNT, never the payload', async () => {
    const { sessionId } = await loadHistory(null, 'u1', null);
    for (let i = 0; i < 105; i++) {
      await appendTurns(null, 'u1', sessionId, [user(`turn-${i}`)]);
    }
    const { history } = await loadHistory(null, 'u1', sessionId);
    expect(history).toHaveLength(100);
    expect(history[0]).toEqual(user('turn-5')); // 0..4 dropped
    expect(history[99]).toEqual(user('turn-104'));
  });

  it('a result turn round-trips its full report_schema object — not a URL, not a truncated copy', async () => {
    const artifact = JSON.parse(readFileSync(PROBE_ARTIFACT_PATH, 'utf8')) as Record<string, unknown>;
    const result: AgentChatResult = { title: artifact.title as string, report_schema: artifact };

    const { sessionId } = await loadHistory(null, 'u1', null);
    await appendTurns(null, 'u1', sessionId, [
      { role: 'assistant', type: 'result', content: 'I have built it.', result },
    ]);

    const { history } = await loadHistory(null, 'u1', sessionId);
    expect(history).toHaveLength(1);
    const turn = history[0];
    if (turn.role !== 'assistant' || turn.type !== 'result') {
      throw new Error('expected an assistant result turn');
    }
    expect(turn.result.report_schema).toEqual(artifact); // deep-equal against the real probe artifact
    expect(turn.result.title).toBe('Fleet Distance & Trip Summary — Last 7 Days');
  });

  it('evicts oldest-first when MAX_SESSIONS = 500 overflows', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      nowSpy.mockReturnValue(t0 + i); // strictly increasing — user-0 is strictly oldest
      ids.push((await loadHistory(null, `user-${i}`, null)).sessionId);
    }

    nowSpy.mockReturnValue(t0 + 500);
    await loadHistory(null, 'user-500', null); // the 501st session

    // Assert the SURVIVOR first: loadHistory is resolve-or-CREATE, so probing the
    // evicted user first would mint a fresh 501st session and cascade-evict the
    // very survivor this assertion is about.
    nowSpy.mockReturnValue(t0 + 501);
    const survivor = await loadHistory(null, 'user-1', ids[1]);
    expect(survivor.sessionId).toBe(ids[1]); // second-oldest survived

    const evicted = await loadHistory(null, 'user-0', ids[0]);
    expect(evicted.sessionId).not.toBe(ids[0]); // oldest is gone — minted fresh
    expect(evicted.persisted).toBe(false);
  });

  it('sweeps sessions older than the 2 h TTL on write', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = 1_700_000_000_000;

    nowSpy.mockReturnValue(t0);
    const first = await loadHistory(null, 'ttl-user', null);
    await appendTurns(null, 'ttl-user', first.sessionId, [user('hello')]);

    // A WRITE for a DIFFERENT user past the TTL runs the lazy sweep.
    nowSpy.mockReturnValue(t0 + TTL_MS + 1);
    await appendTurns(null, 'other-user', 'adopted-session-id', [user('x')]);

    // Rewind the clock to prove the WRITE above did the eviction: at t0 the session
    // would not be expired, so if it were still in the map this read would find it.
    nowSpy.mockReturnValue(t0);
    const again = await loadHistory(null, 'ttl-user', first.sessionId);
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(again.history).toEqual([]);
  });
});

describe('chatStore — the Postgres failure contract (never rejects)', () => {
  const rejectingPool = {
    query: () => Promise.reject(new Error('boom')),
    connect: () => Promise.reject(new Error('boom')),
  } as unknown as Pool;

  it('loadHistory RESOLVES to an in-memory result when the pool rejects, with a logger.warn', async () => {
    const warnSpy = jest.spyOn(logger, 'warn');
    const out = await loadHistory(rejectingPool, 'u1', null);
    expect(out.persisted).toBe(false);
    expect(out.sessionId).toMatch(UUID_SHAPE);
    expect(out.history).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('appendTurns RESOLVES when the pool rejects, and the turn survives in memory', async () => {
    const { sessionId } = await loadHistory(rejectingPool, 'u1', null);
    await expect(
      appendTurns(rejectingPool, 'u1', sessionId, [user('degraded but alive')]),
    ).resolves.toBeUndefined();

    // The whole degraded flow stays coherent for this process.
    const reloaded = await loadHistory(rejectingPool, 'u1', sessionId);
    expect(reloaded.sessionId).toBe(sessionId);
    expect(reloaded.history).toEqual([user('degraded but alive')]);
  });
});

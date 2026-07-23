import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { logger } from '../../../utils/logger.js';
import {
  loadHistory, appendTurns, tenantKeyFor, __resetChatStoreForTests,
} from '../chatStore.js';
import type { AgentChatResult, AgentTurn } from '../types.js';

// The in-memory fallback path — no database anywhere. The Postgres failure
// contract (a rejecting pool must DEGRADE, never reject) runs against an injected
// stub pool here; the split-write/recovery contract lives in chatStore.replay.test.ts
// against a scripted SQL stub; the happy path against a REAL server stays covered
// by the MR's manual M-PERSIST check.

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 2 * 60 * 60 * 1000;

/** The REAL artifact the live agent produced on 2026-07-20 (vendored by MR 3). */
const PROBE_ARTIFACT_PATH = fileURLToPath(new URL('./fixtures/artifact.json', import.meta.url));

/** Store identity — the tenantKey is opaque to the store, so tests use plain
 *  strings; tenantKeyFor's URL-hashing contract is pinned separately below. */
const ident = (userId: string, tenantKey = 'tenant-1') => ({ tenantKey, userId });

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
    const { sessionId, history, persisted } = await loadHistory(null, ident('u1'), null);
    expect(persisted).toBe(false);
    expect(history).toEqual([]);
    expect(sessionId).toMatch(UUID_SHAPE);

    const turns: AgentTurn[] = [
      user('build me a mileage dashboard'),
      question('Which time range?'),
      user('last 7 days'),
      question('Which vehicles?'),
    ];
    await appendTurns(null, ident('u1'), sessionId, [turns[0]]);
    await appendTurns(null, ident('u1'), sessionId, [turns[1]]);
    await appendTurns(null, ident('u1'), sessionId, [turns[2], turns[3]]);

    const reloaded = await loadHistory(null, ident('u1'), sessionId);
    expect(reloaded.sessionId).toBe(sessionId);
    expect(reloaded.persisted).toBe(false);
    expect(reloaded.history).toEqual(turns);
  });

  it('yields a live session for an unknown session_id instead of throwing (D13)', async () => {
    const first = await loadHistory(null, ident('u1'), 'not-a-real-session');
    expect(first.sessionId).toMatch(UUID_SHAPE);
    expect(first.sessionId).not.toBe('not-a-real-session');

    // The server is authoritative: a SECOND bogus id resolves to the user's single
    // active session (D7), not to another fresh one.
    const second = await loadHistory(null, ident('u1'), 'another-bogus-id');
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('two concurrent turn-1 calls yield one session, not two', async () => {
    // No await between the map lookup and the insert — the resolve-or-create runs in
    // one synchronous tick, so both concurrent calls land on the same session.
    const [a, b] = await Promise.all([
      loadHistory(null, ident('race-user'), null),
      loadHistory(null, ident('race-user'), null),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
  });

  it('caps a session at MAX_TURNS = 100 by dropping oldest — the COUNT, never the payload', async () => {
    const { sessionId } = await loadHistory(null, ident('u1'), null);
    for (let i = 0; i < 105; i++) {
      await appendTurns(null, ident('u1'), sessionId, [user(`turn-${i}`)]);
    }
    const { history } = await loadHistory(null, ident('u1'), sessionId);
    expect(history).toHaveLength(100);
    expect(history[0]).toEqual(user('turn-5')); // 0..4 dropped
    expect(history[99]).toEqual(user('turn-104'));
  });

  it('a result turn round-trips its full report_schema object — not a URL, not a truncated copy', async () => {
    const artifact = JSON.parse(readFileSync(PROBE_ARTIFACT_PATH, 'utf8')) as Record<string, unknown>;
    const result: AgentChatResult = { title: artifact.title as string, report_schema: artifact };

    const { sessionId } = await loadHistory(null, ident('u1'), null);
    await appendTurns(null, ident('u1'), sessionId, [
      { role: 'assistant', type: 'result', content: 'I have built it.', result },
    ]);

    const { history } = await loadHistory(null, ident('u1'), sessionId);
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
      ids.push((await loadHistory(null, ident(`user-${i}`), null)).sessionId);
    }

    nowSpy.mockReturnValue(t0 + 500);
    await loadHistory(null, ident('user-500'), null); // the 501st session

    // Assert the SURVIVOR first: loadHistory is resolve-or-CREATE, so probing the
    // evicted user first would mint a fresh 501st session and cascade-evict the
    // very survivor this assertion is about.
    nowSpy.mockReturnValue(t0 + 501);
    const survivor = await loadHistory(null, ident('user-1'), ids[1]);
    expect(survivor.sessionId).toBe(ids[1]); // second-oldest survived

    const evicted = await loadHistory(null, ident('user-0'), ids[0]);
    expect(evicted.sessionId).not.toBe(ids[0]); // oldest is gone — minted fresh
    expect(evicted.persisted).toBe(false);
  });

  it('sweeps sessions older than the 2 h TTL on write', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = 1_700_000_000_000;

    nowSpy.mockReturnValue(t0);
    const first = await loadHistory(null, ident('ttl-user'), null);
    await appendTurns(null, ident('ttl-user'), first.sessionId, [user('hello')]);

    // A WRITE for a DIFFERENT user past the TTL runs the lazy sweep.
    nowSpy.mockReturnValue(t0 + TTL_MS + 1);
    await appendTurns(null, ident('other-user'), 'adopted-session-id', [user('x')]);

    // Rewind the clock to prove the WRITE above did the eviction: at t0 the session
    // would not be expired, so if it were still in the map this read would find it.
    nowSpy.mockReturnValue(t0);
    const again = await loadHistory(null, ident('ttl-user'), first.sessionId);
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(again.history).toEqual([]);
  });
});

describe('chatStore — tenant isolation (MR !61 review, Critical)', () => {
  // userId is only unique within ONE tenant's settings database, and login trusts
  // any presented userDbUrl — a hostile tenant can mint a JWT for a CHOSEN userId.
  // The fallback map must therefore never key on bare userId.
  const sharedUserId = '11111111-2222-3333-4444-555555555555';

  it('the same userId under two different tenants yields two isolated sessions', async () => {
    const a = await loadHistory(null, ident(sharedUserId, 'tenant-a'), null);
    await appendTurns(null, ident(sharedUserId, 'tenant-a'), a.sessionId, [
      user('tenant A private prompt'),
    ]);

    // Tenant B presents the colliding (or deliberately chosen) userId. It must get
    // a fresh, empty session — not tenant A's transcript, and not tenant A's
    // sessionId, which is also the key to the agent's server-side memory.
    const b = await loadHistory(null, ident(sharedUserId, 'tenant-b'), null);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.history).toEqual([]);

    // Writes stay put in both directions.
    await appendTurns(null, ident(sharedUserId, 'tenant-b'), b.sessionId, [user('tenant B prompt')]);
    const aAgain = await loadHistory(null, ident(sharedUserId, 'tenant-a'), a.sessionId);
    expect(aAgain.sessionId).toBe(a.sessionId);
    expect(aAgain.history).toEqual([user('tenant A private prompt')]);
  });

  it('two distinct degraded pools with the same userId stay isolated (the reviewer scenario)', async () => {
    const rejectingPool = () => ({
      query: () => Promise.reject(new Error('boom')),
      connect: () => Promise.reject(new Error('boom')),
    }) as unknown as Pool;

    const a = await loadHistory(rejectingPool(), ident(sharedUserId, 'tenant-a'), null);
    const b = await loadHistory(rejectingPool(), ident(sharedUserId, 'tenant-b'), null);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('a recreated pool for the SAME tenant keeps the same fallback session', async () => {
    // The map is keyed by tenantKey (URL-derived), deliberately NOT by Pool object
    // identity: a pool recreation (e.g. password rotation) must not orphan the
    // transcript.
    const rejectingPool = () => ({
      query: () => Promise.reject(new Error('boom')),
      connect: () => Promise.reject(new Error('boom')),
    }) as unknown as Pool;

    const a = await loadHistory(rejectingPool(), ident('u1'), null);
    const b = await loadHistory(rejectingPool(), ident('u1'), null);
    expect(b.sessionId).toBe(a.sessionId);
  });
});

describe('chatStore — byte budgets on the fallback (MR !61 review)', () => {
  // Count caps alone admitted ~250 MiB per session (100 turns can hold ~50 results
  // at the 5 MiB artifact cap) and hundreds of GiB across 500 sessions. The store
  // now also budgets SERIALIZED BYTES — dropping whole oldest turns/sessions, never
  // truncating a retained payload.
  const MIB = 1024 * 1024;
  const bigTurn = (label: string, mib: number): AgentTurn => ({
    role: 'assistant', type: 'result', content: label,
    result: {
      title: label,
      report_schema: { title: label, panels: [], blob: 'x'.repeat(mib * MIB) },
    },
  });

  it('caps a session at 8 MiB by dropping whole oldest turns; the newest payload stays intact', async () => {
    const { sessionId } = await loadHistory(null, ident('u1'), null);
    for (let i = 0; i < 9; i++) {
      await appendTurns(null, ident('u1'), sessionId, [bigTurn(`turn-${i}`, 1)]);
    }

    const { history } = await loadHistory(null, ident('u1'), sessionId);
    expect(history.length).toBeLessThan(9); // byte-capped far below MAX_TURNS = 100
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]).not.toMatchObject({ content: 'turn-0' }); // oldest went first

    const newest = history[history.length - 1];
    if (newest.role !== 'assistant' || newest.type !== 'result') {
      throw new Error('expected an assistant result turn');
    }
    expect(newest.content).toBe('turn-8');
    const schema = newest.result.report_schema as { blob: string };
    expect(schema.blob).toHaveLength(MIB); // intact — never truncated to fit
  });

  it('caps the whole fallback at 64 MiB by evicting whole oldest sessions', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = 1_700_000_000_000;
    const ids: string[] = [];

    // Ten tenants' users at ~7 MiB each — 70 MiB demanded of a 64 MiB budget.
    for (let u = 0; u < 10; u++) {
      nowSpy.mockReturnValue(t0 + u); // strictly increasing — g0 is strictly oldest
      const { sessionId } = await loadHistory(null, ident(`g${u}`), null);
      ids.push(sessionId);
      for (let i = 0; i < 7; i++) {
        await appendTurns(null, ident(`g${u}`), sessionId, [bigTurn(`g${u}-turn-${i}`, 1)]);
      }
    }

    // Survivor FIRST (loadHistory is resolve-or-CREATE — probing the evicted user
    // first would mint a session and shift the byte ledger this test is about).
    nowSpy.mockReturnValue(t0 + 100);
    const survivor = await loadHistory(null, ident('g9'), ids[9]);
    expect(survivor.sessionId).toBe(ids[9]);
    expect(survivor.history).toHaveLength(7); // eviction is whole-session, not per-turn

    const evicted = await loadHistory(null, ident('g0'), ids[0]);
    expect(evicted.sessionId).not.toBe(ids[0]); // oldest session paid for the budget
  });
});

describe('tenantKeyFor', () => {
  it('is a stable sha256 hex that never contains the password', () => {
    const url = 'postgresql://app:s3kret-pw@db.tenant-a.example:5432/meta';
    const key = tenantKeyFor(url);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(tenantKeyFor(url)).toBe(key); // deterministic — the fallback survives across requests
    expect(key).not.toContain('s3kret-pw');
    expect(tenantKeyFor('postgresql://app:other@db.tenant-b.example:5432/meta')).not.toBe(key);
  });

  // MR !61 round 3 (note 56573): the key must be the NORMALIZED pool identity, not a
  // hash of the raw string. parsePostgresUrl drops every query parameter except
  // sslmode, so URLs differing only in ignored parameters — or only in password —
  // reach the SAME database through the SAME pool. A raw-string hash handed each
  // spelling its own 20/min rate-limit bucket (?application_name=1, =2, … was a
  // working bypass) and lost the fallback transcript on password rotation.
  it('collapses URLs that differ only in ignored query parameters (the rate-limit bypass)', () => {
    const base = 'postgresql://app:pw@db.tenant-a.example:5432/meta';
    const key = tenantKeyFor(base);
    expect(tenantKeyFor(`${base}?application_name=1`)).toBe(key);
    expect(tenantKeyFor(`${base}?application_name=2`)).toBe(key);
    expect(tenantKeyFor(`${base}?sslmode=require`)).toBe(key); // transport, not identity
  });

  it('is stable across password rotation — the pool survives, so must the tenant key', () => {
    expect(tenantKeyFor('postgresql://app:old-pw@db.tenant-a.example:5432/meta'))
      .toBe(tenantKeyFor('postgresql://app:new-pw@db.tenant-a.example:5432/meta'));
  });

  it('inherits pool normalization: localhost spellings and the default port collapse', () => {
    // Outside Docker parsePostgresUrl maps localhost → 127.0.0.1; jest runs outside.
    expect(tenantKeyFor('postgresql://app:pw@localhost:5432/meta'))
      .toBe(tenantKeyFor('postgresql://app:pw@127.0.0.1:5432/meta'));
    expect(tenantKeyFor('postgresql://app:pw@db.tenant-a.example/meta'))
      .toBe(tenantKeyFor('postgresql://app:pw@db.tenant-a.example:5432/meta'));
  });

  // MR !61 round 4 (note 56582): equivalence must extend to the network endpoint
  // itself. postgresql: is a non-special URL scheme, so hostname case, a trailing
  // root dot and numeric IPv4 shorthand all survived parsing — each spelling a
  // fresh 20/min bucket (16 case-spellings of one host = 16 buckets, measured).
  it('collapses DNS-equivalent hostname spellings — case, root dot, numeric IPv4', () => {
    const key = tenantKeyFor('postgresql://app:pw@db.tenant-a.example:5432/meta');
    expect(tenantKeyFor('postgresql://app:pw@DB.TENANT-A.EXAMPLE:5432/meta')).toBe(key);
    expect(tenantKeyFor('postgresql://app:pw@db.tenant-a.example.:5432/meta')).toBe(key);
    expect(tenantKeyFor('postgresql://app:pw@127.1:5432/meta'))
      .toBe(tenantKeyFor('postgresql://app:pw@127.0.0.1:5432/meta'));
  });

  it('still isolates real tenants: user, host and database each split the key', () => {
    const base = tenantKeyFor('postgresql://app:pw@db.tenant-a.example:5432/meta');
    expect(tenantKeyFor('postgresql://other:pw@db.tenant-a.example:5432/meta')).not.toBe(base);
    expect(tenantKeyFor('postgresql://app:pw@db.tenant-b.example:5432/meta')).not.toBe(base);
    expect(tenantKeyFor('postgresql://app:pw@db.tenant-a.example:5432/other')).not.toBe(base);
  });

  it('never throws — an unparseable URL degrades to a raw-string key (finer, never coarser)', () => {
    // Unreachable for a URL that passed login, but the limiter's keyGenerator must
    // never throw: errorHandler would 500 every chat request.
    const a = tenantKeyFor('not-a-postgres-url');
    const b = tenantKeyFor('postgresql:///no-host');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('chatStore — the Postgres failure contract (never rejects)', () => {
  const rejectingPool = {
    query: () => Promise.reject(new Error('boom')),
    connect: () => Promise.reject(new Error('boom')),
  } as unknown as Pool;

  it('loadHistory RESOLVES to an in-memory result when the pool rejects, with a logger.warn', async () => {
    const warnSpy = jest.spyOn(logger, 'warn');
    const out = await loadHistory(rejectingPool, ident('u1'), null);
    expect(out.persisted).toBe(false);
    expect(out.sessionId).toMatch(UUID_SHAPE);
    expect(out.history).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('appendTurns RESOLVES when the pool rejects, and the turn survives in memory', async () => {
    const { sessionId } = await loadHistory(rejectingPool, ident('u1'), null);
    await expect(
      appendTurns(rejectingPool, ident('u1'), sessionId, [user('degraded but alive')]),
    ).resolves.toBeUndefined();

    // The whole degraded flow stays coherent for this process.
    const reloaded = await loadHistory(rejectingPool, ident('u1'), sessionId);
    expect(reloaded.sessionId).toBe(sessionId);
    expect(reloaded.history).toEqual([user('degraded but alive')]);
  });
});

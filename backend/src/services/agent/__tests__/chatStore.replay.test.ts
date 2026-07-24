import { describe, it, expect, afterEach, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { loadHistory, appendTurns, __resetChatStoreForTests } from '../chatStore.js';
import type { AgentTurn } from '../types.js';

/**
 * The split-write / recovery contract (MR !61 review, Important): a turn that fails
 * its Postgres write is BUFFERED in memory and REPLAYED into Postgres on the next
 * healthy touch — a partial failure can never orphan the assistant's result, and a
 * memory-era transcript survives the tables being applied.
 *
 * These tests drive the real store through a SCRIPTED stub pool that emulates just
 * enough of the SQL surface (session get-or-create, message insert with
 * ON CONFLICT (id) DO NOTHING, transactions, the history read). It is a protocol
 * emulation, not a Postgres: the happy path against a real server stays covered by
 * the MR's manual M-PERSIST check.
 */

const ident = (userId: string, tenantKey = 'tenant-1') => ({ tenantKey, userId, demo: false });

const user = (content: string): AgentTurn => ({ role: 'user', content });
const question = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});

interface MsgRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  type: string | null;
  result: string | null;
  at: number; // created_at, ms
}

interface Script {
  tablesExist: boolean;
  /** Every chat_messages INSERT throws while true. */
  failMessageInsert: boolean;
  /** Emulates an in-doubt COMMIT once: the server APPLIES the transaction, but the
   *  client sees an error — the classic case where "retry the INSERT" duplicates. */
  failCommitOnceAfterApply: boolean;
}

function makeScriptedPool() {
  const db = {
    sessions: [] as Array<{ id: string; user_id: string; created_at: number }>,
    messages: [] as MsgRow[],
  };
  const script: Script = {
    tablesExist: true,
    failMessageInsert: false,
    failCommitOnceAfterApply: false,
  };
  // Every normalized statement, in issue order — lets a test assert the LOCK →
  // INSERT → prune ordering the concurrency fix depends on (MR !61 round 6).
  const calls: string[] = [];
  let mintedSession = 0;
  let txn: MsgRow[] | null = null;

  const applied = () => db.messages;
  const idTaken = (id: string) => applied().some((m) => m.id === id) || (txn ?? []).some((m) => m.id === id);

  const client = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount?: number }> {
      const q = sql.replace(/\s+/g, ' ').trim();
      calls.push(q);

      // Session row lock (round 6): a no-op read in the stub — the store ignores
      // the result and uses it only to serialize concurrent writers on a real
      // server. Matched before the plain chat_sessions lookups below so the
      // trace records it distinctly.
      if (q.includes('chat_sessions') && q.includes('FOR UPDATE')) {
        const found = db.sessions.find((s) => s.id === params[0] && s.user_id === params[1]);
        return { rows: found ? [{ '?column?': 1 }] : [] };
      }

      if (q === 'BEGIN') { txn = []; return { rows: [] }; }
      if (q === 'COMMIT') {
        const buffered = txn ?? [];
        txn = null;
        db.messages.push(...buffered);
        if (script.failCommitOnceAfterApply) {
          script.failCommitOnceAfterApply = false;
          throw new Error('COMMIT connection lost (scripted, applied server-side)');
        }
        return { rows: [] };
      }
      if (q === 'ROLLBACK') { txn = null; return { rows: [] }; }

      if (q.includes('information_schema.tables')) {
        return { rows: [{ exists: script.tablesExist }] };
      }

      if (q.includes('INSERT INTO dashboard_studio_meta_data.chat_sessions')) {
        const userId = String(params[0]);
        if (db.sessions.some((s) => s.user_id === userId)) return { rows: [] }; // ON CONFLICT DO NOTHING
        const row = { id: `00000000-0000-4000-8000-${String(++mintedSession).padStart(12, '0')}`, user_id: userId, created_at: mintedSession };
        db.sessions.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (q.includes('FROM dashboard_studio_meta_data.chat_sessions') && q.includes('id = $1')) {
        const found = db.sessions.find((s) => s.id === params[0] && s.user_id === params[1]);
        return { rows: found ? [{ id: found.id }] : [] };
      }
      if (q.includes('FROM dashboard_studio_meta_data.chat_sessions')) {
        const rows = db.sessions
          .filter((s) => s.user_id === params[0])
          .sort((a, b) => b.created_at - a.created_at)
          .map((s) => ({ id: s.id }));
        return { rows: rows.slice(0, 1) };
      }

      if (q.includes('INSERT INTO dashboard_studio_meta_data.chat_messages')) {
        if (script.failMessageInsert) throw new Error('message insert refused (scripted)');
        // The store-minted shape: (id, session, user, role, content, type, result, at).
        // A regression to letting the DATABASE mint ids/timestamps must fail loudly —
        // it would silently break replay idempotence and ordering.
        if (params.length !== 8) {
          throw new Error(`unexpected chat_messages INSERT shape: ${params.length} params`);
        }
        const row: MsgRow = {
          id: String(params[0]), session_id: String(params[1]), user_id: String(params[2]),
          role: String(params[3]), content: String(params[4]),
          type: params[5] === null ? null : String(params[5]),
          result: params[6] === null ? null : String(params[6]),
          at: Number(params[7]),
        };
        if (idTaken(row.id)) return { rows: [] }; // ON CONFLICT (id) DO NOTHING
        (txn ?? db.messages).push(row);
        return { rows: [] };
      }

      if (q.includes('UPDATE dashboard_studio_meta_data.chat_sessions')) {
        return { rows: [] };
      }

      // RETENTION (review round 5): keep the newest $3 rows per session by seq —
      // the stub's seq is insertion order across applied rows plus this txn's own
      // (a real DELETE sees the transaction's inserts). Checked BEFORE the history
      // read: the prune's subquery also contains 'FROM …chat_messages'. Emulated
      // as applied-at-execution; every scripted failure fires before the prune
      // runs, so txn-rollback fidelity is not needed here.
      if (q.startsWith('DELETE FROM dashboard_studio_meta_data.chat_messages')) {
        const inSession = [...db.messages, ...(txn ?? [])]
          .filter((m) => m.session_id === params[0] && m.user_id === params[1]);
        const doomed = new Set(
          inSession.slice(0, Math.max(0, inSession.length - Number(params[2]))).map((m) => m.id),
        );
        db.messages = db.messages.filter((m) => !doomed.has(m.id));
        if (txn) txn = txn.filter((m) => !doomed.has(m.id));
        return { rows: [], rowCount: doomed.size };
      }

      if (q.includes('FROM dashboard_studio_meta_data.chat_messages')) {
        // ORDER BY seq DESC LIMIT n — seq is insertion order, so: last n, newest first.
        const rows = applied()
          .filter((m) => m.session_id === params[0] && m.user_id === params[1])
          .slice(-Number(params[2]))
          .reverse()
          .map((m) => ({
            id: m.id, role: m.role, type: m.type, content: m.content,
            result: m.result === null ? null : JSON.parse(m.result),
          }));
        return { rows };
      }

      throw new Error(`unscripted SQL: ${q.slice(0, 100)}`);
    },
    release(): void { /* no-op */ },
  };

  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, db, script, calls };
}

afterEach(() => {
  __resetChatStoreForTests();
  jest.restoreAllMocks();
});

describe('chatStore — buffered replay on Postgres recovery (MR !61 review)', () => {
  it('heals the reviewer sequence: user turn lands, assistant write fails, next healthy load shows BOTH', async () => {
    const { pool, script } = makeScriptedPool();

    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [user('build a fleet dashboard')]);

    script.failMessageInsert = true; // Postgres refuses mid-request
    await appendTurns(pool, ident('u1'), sessionId, [question('Which time range?')]);
    script.failMessageInsert = false; // and recovers before the next request

    const reloaded = await loadHistory(pool, ident('u1'), sessionId);
    expect(reloaded.persisted).toBe(true);
    expect(reloaded.history).toEqual([
      user('build a fleet dashboard'),
      question('Which time range?'),
    ]);

    // Idempotent: a further load must not re-replay or duplicate.
    const again = await loadHistory(pool, ident('u1'), sessionId);
    expect(again.history).toHaveLength(2);
  });

  it('a memory-era transcript survives the tables being applied (recovery after fallback)', async () => {
    const { pool, db, script } = makeScriptedPool();
    script.tablesExist = false; // 002 not applied yet

    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = 1_700_000_000_000;
    nowSpy.mockReturnValue(t0);

    const memoryEra = await loadHistory(pool, ident('u1'), null);
    expect(memoryEra.persisted).toBe(false);
    await appendTurns(pool, ident('u1'), memoryEra.sessionId, [user('hello')]);
    await appendTurns(pool, ident('u1'), memoryEra.sessionId, [question('Which vehicles?')]);

    // The DBA applies 002. The probe result is cached, so recovery is observed
    // after the probe TTL (60 s), not instantly.
    script.tablesExist = true;
    nowSpy.mockReturnValue(t0 + 61_000);

    const recovered = await loadHistory(pool, ident('u1'), memoryEra.sessionId);
    expect(recovered.persisted).toBe(true);
    expect(recovered.sessionId).not.toBe(memoryEra.sessionId); // D13: fresh Postgres session
    expect(recovered.history).toEqual([user('hello'), question('Which vehicles?')]);

    // And they are truly IN Postgres, in insertion (= seq) order, not merely
    // merged into the response.
    expect(db.messages.map((m) => m.content)).toEqual(['hello', 'Which vehicles?']);
    expect(new Set(db.messages.map((m) => m.session_id))).toEqual(new Set([recovered.sessionId]));
  });

  it('an in-doubt COMMIT cannot duplicate a turn: store-minted ids dedupe the replay', async () => {
    const { pool, db, script } = makeScriptedPool();

    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    // The server applies the transaction but the client sees a failure — the exact
    // case where a blind retry duplicates the row.
    script.failCommitOnceAfterApply = true;
    await appendTurns(pool, ident('u1'), sessionId, [user('exactly once, please')]);

    const reloaded = await loadHistory(pool, ident('u1'), sessionId);
    expect(reloaded.history).toEqual([user('exactly once, please')]);
    expect(db.messages).toHaveLength(1); // ON CONFLICT (id) DO NOTHING swallowed the replay
  });

  it('drains the buffer BEFORE appending new turns, so a healed transcript keeps its order', async () => {
    const { pool, db, script } = makeScriptedPool();

    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    script.failMessageInsert = true; // the user turn write fails...
    await appendTurns(pool, ident('u1'), sessionId, [user('first')]);
    script.failMessageInsert = false; // ...and Postgres is back for the assistant turn

    await appendTurns(pool, ident('u1'), sessionId, [question('second')]);

    const { history } = await loadHistory(pool, ident('u1'), sessionId);
    expect(history).toEqual([user('first'), question('second')]);

    // Insertion (= seq) order carries the healed order — even when both writes
    // land in the same millisecond and created_at ties.
    expect(db.messages.map((m) => m.content)).toEqual(['first', 'second']);
  });
});

// MR !61 round 5 (note 56601): every turn INSERTed unconditionally while
// MAX_TURNS bounded only the SELECT and the memory path — 101 exchanges left 202
// rows (result payloads included) in the tenant's settings DB with the API able
// to return just the newest 100, and growth never stopped. The store now prunes
// past the bound inside the SAME transaction as the inserts, on both write
// paths. Retention IS visibility: only rows the read path can never return
// again are deleted.
describe('chatStore — Postgres retention (MR !61 round 5)', () => {
  it('bounds persisted rows per session at MAX_TURNS — the newest 100, exactly what reads expose', async () => {
    const { pool, db } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    // 51 exchanges = 102 turns, appended in the route's user+assistant rhythm.
    for (let i = 0; i < 51; i++) {
      await appendTurns(pool, ident('u1'), sessionId, [user(`u-${i}`)]);
      await appendTurns(pool, ident('u1'), sessionId, [question(`a-${i}`)]);
    }

    expect(db.messages).toHaveLength(100); // not 102 — the oldest exchange is gone
    expect(db.messages[0].content).toBe('u-1');

    const { history } = await loadHistory(pool, ident('u1'), sessionId);
    expect(history).toHaveLength(100);
    expect(history[0]).toEqual(user('u-1'));
    expect(history[99]).toEqual(question('a-50'));
  });

  it('the replay path prunes too: a drained outage buffer cannot overfill the table', async () => {
    const { pool, db, script } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    for (let i = 0; i < 60; i++) {
      await appendTurns(pool, ident('u1'), sessionId, [user(`pg-${i}`)]);
    }
    script.failMessageInsert = true; // outage: the next 60 turns buffer in memory
    for (let i = 0; i < 60; i++) {
      await appendTurns(pool, ident('u1'), sessionId, [user(`buf-${i}`)]);
    }
    script.failMessageInsert = false;

    // The healthy read drains all 60 buffered turns into Postgres in one
    // transaction — which must leave 100 rows, not 120.
    const { history } = await loadHistory(pool, ident('u1'), sessionId);
    expect(db.messages).toHaveLength(100);
    expect(db.messages[0].content).toBe('pg-20');
    expect(history).toHaveLength(100);
  });
});

// MR !61 round 6 (note 56627): round 5's prune is a read-modify-write — it derives
// a DELETE boundary from a COUNT, then deletes. Under READ COMMITTED two concurrent
// append/replay transactions each take their pre-INSERT snapshot before the other's
// turn is visible, pick the SAME boundary and delete one row while inserting two, so
// the table settles at MAX_TURNS+1. Reproduced on real PostgreSQL 16 (start 100, two
// parallel BEGIN/INSERT/prune: deleteA=1, deleteB=0, count=101) and closed by a row
// lock — SELECT … FOR UPDATE on the session — taken at the TOP of BOTH write
// transactions, before any INSERT or prune, so the second writer blocks until the
// first commits and re-counts against the true total.
//
// A genuine two-connection race needs a live server; this suite is a single-
// connection protocol emulation BY DESIGN (see the file header and chatStore.ts's —
// its jest suites run against stub pools, not a database). So the real concurrency is
// covered by the MR's PG16 reproduction, and here we pin the MECHANISM the fix relies
// on: the lock is issued, and issued BEFORE the first message INSERT and the prune,
// on both write paths. Remove or reorder lockSession and both tests go red.
describe('chatStore — per-session write serialization (MR !61 round 6)', () => {
  const idxLock = (calls: string[]) =>
    calls.findIndex((q) => q.includes('chat_sessions') && q.includes('FOR UPDATE'));
  const idxBegin = (calls: string[]) => calls.indexOf('BEGIN');
  const idxFirstInsert = (calls: string[]) =>
    calls.findIndex((q) => q.startsWith('INSERT INTO dashboard_studio_meta_data.chat_messages'));
  const idxPrune = (calls: string[]) =>
    calls.findIndex((q) => q.startsWith('DELETE FROM dashboard_studio_meta_data.chat_messages'));

  it('append path: locks the session (FOR UPDATE) before the message INSERT and the prune', async () => {
    const { pool, calls } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    calls.length = 0; // isolate the append transaction from the initial load

    await appendTurns(pool, ident('u1'), sessionId, [user('hello')]);

    const begin = idxBegin(calls);
    const lock = idxLock(calls);
    expect(begin).toBeGreaterThanOrEqual(0); // the append opened a transaction
    expect(lock).toBeGreaterThan(begin); // the lock is INSIDE it
    expect(idxFirstInsert(calls)).toBeGreaterThan(lock); // ...before the INSERT
    expect(idxPrune(calls)).toBeGreaterThan(lock); // ...and before the prune
  });

  it('replay path: the reconciliation transaction locks the session before draining and pruning', async () => {
    const { pool, calls, script } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    // Buffer a turn through an outage so the next healthy load runs the replay txn.
    script.failMessageInsert = true;
    await appendTurns(pool, ident('u1'), sessionId, [user('buffered')]);
    script.failMessageInsert = false;

    calls.length = 0; // isolate the load-with-replay
    await loadHistory(pool, ident('u1'), sessionId);

    const begin = idxBegin(calls);
    const lock = idxLock(calls);
    expect(begin).toBeGreaterThanOrEqual(0); // replay opened a transaction
    expect(lock).toBeGreaterThan(begin);
    expect(idxFirstInsert(calls)).toBeGreaterThan(lock); // the replayed turn's INSERT
    expect(idxPrune(calls)).toBeGreaterThan(lock);
  });
});

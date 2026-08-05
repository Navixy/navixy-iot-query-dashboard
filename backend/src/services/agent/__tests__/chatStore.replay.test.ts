import { describe, it, expect, afterEach, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { loadHistory, appendTurns, getTurnStatus, __resetChatStoreForTests } from '../chatStore.js';
import type { AgentTurn } from '../types.js';
// The wire body builder, imported across the layer on purpose: the round-16
// finding is about what the STORED row becomes on the way out, and only the two
// together show that.
import { buildSessionResponse } from '../../../routes/agent.js';

/**
 * The split-write / recovery contract (MR !61 review, Important): a turn that fails
 * its Postgres write is BUFFERED in memory and REPLAYED into Postgres by a later
 * healthy touch, so a memory-era transcript can survive the tables being applied.
 *
 * BEST-EFFORT, and these tests do not claim more (!65 round 13 — this header said a
 * partial failure "can never orphan the assistant's result"). Every case below HANDS
 * the store a later touch on the same process; production may never produce one. The
 * buffer is process-local and bounded — MAX_TURNS, MAX_SESSION_BYTES, MAX_TOTAL_BYTES,
 * SESSION_TTL_MS — nothing replays on a timer, and a restart or an eviction ends it.
 * What the in-doubt-COMMIT case pins is IDEMPOTENCE: a replay cannot duplicate a turn.
 * That bounds the damage a replay can do; it says nothing about whether one occurs.
 * Same bounds in the outcome table of docs/ai-agent-seam.md §7.
 *
 * These tests drive the real store through a SCRIPTED stub pool that emulates just
 * enough of the SQL surface (session get-or-create, message insert with
 * ON CONFLICT (id) DO NOTHING, transactions, the history read). It is a protocol
 * emulation, not a Postgres: the happy path against a real server stays covered by
 * the MR's manual M-PERSIST check.
 */

const ident = (userId: string, tenantKey = 'tenant-1') => ({ tenantKey, userId, demo: false });

const user = (content: string): AgentTurn => ({ role: 'user', content });
const userWithId = (content: string, client_turn_id: string): AgentTurn => ({
  role: 'user', content, client_turn_id,
});
const question = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});
const questionWithId = (content: string, client_turn_id: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null, client_turn_id,
});

interface MsgRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  type: string | null;
  result: string | null;
  client_turn_id: string | null;
  at: number; // created_at, ms
}

interface Script {
  tablesExist: boolean;
  /** Whether the round-6 client_turn_id column exists on chat_messages. Tenants on
   *  an earlier 002 have the tables but not the column; the store must keep
   *  persisting without it. */
  clientTurnIdColumn: boolean;
  /** Whether the round-7 chat_turn_receipts table exists. */
  receiptsTable: boolean;
  /** Whether 004 has scoped its primary key to (user_id, client_turn_id). The
   *  store refuses to use a globally-keyed table (review !62 round 12). */
  receiptsPerUserKey: boolean;
  /** Every chat_messages INSERT throws while true. */
  failMessageInsert: boolean;
  /** The single-active-turn probe throws while true (review !62 round 13,
   *  Important 1) — the ONE read that decides awaiting_reply, failing on its own
   *  while the transcript read succeeds. */
  failActiveTurnProbe: boolean;
  /** Emulates an in-doubt COMMIT once: the server APPLIES the transaction, but the
   *  client sees an error — the classic case where "retry the INSERT" duplicates. */
  failCommitOnceAfterApply: boolean;
}

function makeScriptedPool() {
  const db = {
    sessions: [] as Array<{ id: string; user_id: string; created_at: number }>,
    messages: [] as MsgRow[],
    receipts: [] as Array<{ client_turn_id: string; user_id: string; session_id: string; status: string; at: number }>,
  };
  const script: Script = {
    tablesExist: true,
    clientTurnIdColumn: true,
    receiptsTable: true,
    receiptsPerUserKey: true,
    failMessageInsert: false,
    failActiveTurnProbe: false,
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

      // Matched before the tables probe: the column probe is a distinct
      // information_schema query (review !62 round 6).
      if (q.includes('information_schema.columns')) {
        return { rows: [{ exists: script.clientTurnIdColumn }] };
      }
      if (q.includes('information_schema.tables')) {
        // The receipts table (round 7) is a distinct table probe.
        if (q.includes("'chat_turn_receipts'")) {
          return { rows: [{ exists: script.receiptsTable }] };
        }
        return { rows: [{ exists: script.tablesExist }] };
      }
      // Receipts PRIMARY KEY columns (review !62 round 12, Important 3): the table
      // is only usable once 004 has scoped the key to (user_id, client_turn_id).
      if (q.includes('information_schema.key_column_usage')) {
        if (!script.receiptsTable) return { rows: [] };
        return {
          rows: script.receiptsPerUserKey
            ? [{ column_name: 'user_id' }, { column_name: 'client_turn_id' }]
            : [{ column_name: 'client_turn_id' }],
        };
      }

      // Durable receipts (round 7, finding 5b). Applied directly, not txn-buffered:
      // insertEntry only writes a receipt AFTER a successful message INSERT, and the
      // ON CONFLICT clauses make replay idempotent, so buffer fidelity is not needed.
      if (q.includes('INSERT INTO dashboard_studio_meta_data.chat_turn_receipts')) {
        const id = String(params[0]);
        const answered = q.includes("'answered'");
        // Keyed per user since 004 (review !62 round 12, Important 3).
        const userId = String(params[1]);
        const existing = db.receipts.find(
          (r) => r.client_turn_id === id && r.user_id === userId,
        );
        if (existing) {
          if (q.includes('DO UPDATE')) existing.status = 'answered';
          // else ON CONFLICT DO NOTHING
        } else {
          db.receipts.push({
            client_turn_id: id, user_id: String(params[1]), session_id: String(params[2]),
            status: answered ? 'answered' : 'received',
            // created_at — the stub's clock is the real one; tests that care about
            // the TTL drive it through activeTurnTtlMs instead of a fake clock.
            at: Date.now(),
          });
        }
        return { rows: [] };
      }
      if (q.startsWith('DELETE FROM dashboard_studio_meta_data.chat_turn_receipts')) {
        // Age-based prune; the stub has no clock, so nothing is old enough — no-op.
        return { rows: [], rowCount: 0 };
      }
      // SINGLE ACTIVE TURN probe (review !62 round 10): is a 'received' receipt for
      // this session still inside the window? The stub ignores the interval bound —
      // tests express "expired" by passing activeTurnTtlMs: 0, which the store
      // short-circuits before reaching SQL.
      if (
        q.includes('FROM dashboard_studio_meta_data.chat_turn_receipts') &&
        q.includes("status = 'received'")
      ) {
        if (script.failActiveTurnProbe) {
          throw new Error('active-turn probe failed (scripted)');
        }
        const ttlMs = Number(params[2]) * 1000;
        const cutoff = Date.now() - ttlMs;
        const hit = db.receipts.some(
          (r) => r.user_id === params[0] && r.session_id === params[1]
            && r.status === 'received' && r.at > cutoff,
        );
        return { rows: hit ? [{ '?column?': 1 }] : [] };
      }
      // DUPLICATE-ID probe (review !62 round 11, Important 2): has this
      // client_turn_id been seen in ANY state? The active probe above only sees
      // 'received', so a replayed ANSWERED id slipped past it.
      if (
        q.startsWith('SELECT 1 FROM dashboard_studio_meta_data.chat_turn_receipts') &&
        q.includes('client_turn_id = $1')
      ) {
        const hit = db.receipts.some(
          (r) => r.client_turn_id === params[0] && r.user_id === params[1],
        );
        return { rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (q.includes('SELECT status FROM dashboard_studio_meta_data.chat_turn_receipts')) {
        const r = db.receipts.find(
          (x) => x.client_turn_id === params[0] && x.user_id === params[1],
        );
        return { rows: r ? [{ status: r.status }] : [] };
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
        // Two store-minted shapes (review !62 round 6): WITH the client_turn_id
        // column, 9 params (id, session, user, role, content, type, result,
        // client_turn_id, at); WITHOUT it, the legacy 8 (…, result, at). A
        // regression to letting the DATABASE mint ids/timestamps must still fail
        // loudly — it would break replay idempotence and ordering.
        const withColumn = params.length === 9;
        if (params.length !== 8 && params.length !== 9) {
          throw new Error(`unexpected chat_messages INSERT shape: ${params.length} params`);
        }
        const row: MsgRow = {
          id: String(params[0]), session_id: String(params[1]), user_id: String(params[2]),
          role: String(params[3]), content: String(params[4]),
          type: params[5] === null ? null : String(params[5]),
          result: params[6] === null ? null : String(params[6]),
          client_turn_id: withColumn && params[7] !== null ? String(params[7]) : null,
          at: Number(withColumn ? params[8] : params[7]),
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
        // The read selects client_turn_id only where the column exists (round 6).
        const selectsTurnId = q.includes('client_turn_id');
        const rows = applied()
          .filter((m) => m.session_id === params[0] && m.user_id === params[1])
          .slice(-Number(params[2]))
          .reverse()
          .map((m) => ({
            id: m.id, role: m.role, type: m.type, content: m.content,
            result: m.result === null ? null : JSON.parse(m.result),
            ...(selectsTurnId ? { client_turn_id: m.client_turn_id } : {}),
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

describe('chatStore — client_turn_id idempotency id (review !62 round 6)', () => {
  it('round-trips a user turn client_turn_id through Postgres when the column exists', async () => {
    const { pool, db } = makeScriptedPool(); // clientTurnIdColumn defaults to true
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('build a dashboard', 'turn-abc')]);

    const reloaded = await loadHistory(pool, ident('u1'), sessionId);
    expect(reloaded.persisted).toBe(true);
    // The id survives the persist → read round trip, so the client can reconcile by it.
    expect(reloaded.history).toEqual([userWithId('build a dashboard', 'turn-abc')]);
    // Persisted in the column, not merely echoed.
    expect(db.messages[0].client_turn_id).toBe('turn-abc');
  });

  it('keeps persisting (without the id) when the tenant is on an older schema lacking the column', async () => {
    const { pool, db, script } = makeScriptedPool();
    script.clientTurnIdColumn = false; // tables exist, the round-6 column does not

    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('still works', 'turn-xyz')]);

    const reloaded = await loadHistory(pool, ident('u1'), sessionId);
    // Crucially it did NOT downgrade to in-memory — history stays persisted.
    expect(reloaded.persisted).toBe(true);
    // The turn is there; the id is simply not carried on the older schema.
    expect(reloaded.history).toEqual([user('still works')]);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].client_turn_id).toBeNull();
  });

  it('never stamps a client_turn_id on an assistant turn', async () => {
    const { pool, db } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('q', 'tid-1'), question('a')]);

    const assistantRow = db.messages.find((m) => m.role === 'assistant');
    expect(assistantRow?.client_turn_id).toBeNull();
    const userRow = db.messages.find((m) => m.role === 'user');
    expect(userRow?.client_turn_id).toBe('tid-1');
  });

  it('carries client_turn_id through a buffered replay into Postgres', async () => {
    const { pool, db, script } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    // The write fails, so the turn (with its id) is buffered in memory...
    script.failMessageInsert = true;
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('buffered turn', 'tid-replay')]);
    script.failMessageInsert = false;

    // ...and replays into Postgres on the next healthy load, id intact.
    const reloaded = await loadHistory(pool, ident('u1'), sessionId);
    expect(reloaded.history).toEqual([userWithId('buffered turn', 'tid-replay')]);
    expect(db.messages[0].client_turn_id).toBe('tid-replay');
  });
});

describe('chatStore — assistant reply carries the originating id (review !62 round 7, finding 3)', () => {
  it('stamps the assistant/error row with the user turn\'s client_turn_id', async () => {
    const { pool, db } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('build', 'tid-A')]);
    await appendTurns(pool, ident('u1'), sessionId, [questionWithId('here it is', 'tid-A')]);

    const reloaded = await loadHistory(pool, ident('u1'), sessionId);
    // Both halves of the pair carry the SAME id, so the client matches exactly.
    expect(reloaded.history).toEqual([
      userWithId('build', 'tid-A'),
      questionWithId('here it is', 'tid-A'),
    ]);
    expect(db.messages.map((m) => m.client_turn_id)).toEqual(['tid-A', 'tid-A']);
  });
});

describe('chatStore — supports_turn_ids capability (review !62 round 7, finding 5a)', () => {
  it('is true when the client_turn_id column exists', async () => {
    const { pool } = makeScriptedPool(); // clientTurnIdColumn defaults true
    const result = await loadHistory(pool, ident('u1'), null);
    expect(result.supportsTurnIds).toBe(true);
  });

  it('is false for a tenant on an older 002 without the column', async () => {
    const { pool, script } = makeScriptedPool();
    script.clientTurnIdColumn = false;
    const result = await loadHistory(pool, ident('u1'), null);
    expect(result.persisted).toBe(true); // still persists...
    expect(result.supportsTurnIds).toBe(false); // ...but signals no id round-trip
  });

  it('is true for the in-memory path (it carries ids on the turn objects)', async () => {
    const { pool, script } = makeScriptedPool();
    script.tablesExist = false;
    const result = await loadHistory(pool, ident('u1'), null);
    expect(result.persisted).toBe(false);
    expect(result.supportsTurnIds).toBe(true);
  });
});

describe('chatStore — durable turn receipts (review !62 round 7, finding 5b)', () => {
  it('records received, upgrades to answered, and getTurnStatus reads it back', async () => {
    const { pool } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    await appendTurns(pool, ident('u1'), sessionId, [userWithId('q', 'tid-1')]);
    expect(await getTurnStatus(pool, ident('u1'), 'tid-1')).toEqual({
      status: 'received', supported: true,
    });

    await appendTurns(pool, ident('u1'), sessionId, [questionWithId('a', 'tid-1')]);
    expect(await getTurnStatus(pool, ident('u1'), 'tid-1')).toEqual({
      status: 'answered', supported: true,
    });
  });

  it('confirms a delivered turn EVEN AFTER its content row is evicted (the finding-5b point)', async () => {
    const { pool, db } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('q', 'tid-evicted')]);
    await appendTurns(pool, ident('u1'), sessionId, [questionWithId('a', 'tid-evicted')]);

    // Simulate the 100-row retention evicting this turn's content entirely.
    db.messages.length = 0;

    // The transcript no longer shows it, but the durable receipt still confirms it.
    expect(await getTurnStatus(pool, ident('u1'), 'tid-evicted')).toEqual({
      status: 'answered', supported: true,
    });
  });

  it('returns unknown/supported for an id that never reached the server', async () => {
    const { pool } = makeScriptedPool();
    await loadHistory(pool, ident('u1'), null);
    expect(await getTurnStatus(pool, ident('u1'), 'never-sent')).toEqual({
      status: 'unknown', supported: true,
    });
  });

  it('reports unsupported (and keeps persisting) when the receipts table is absent', async () => {
    const { pool, script } = makeScriptedPool();
    script.receiptsTable = false;
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('q', 'tid-x')]); // must not throw
    expect(await getTurnStatus(pool, ident('u1'), 'tid-x')).toEqual({
      status: 'unknown', supported: false,
    });
  });

  it('never exposes a demo identity\'s turn status from Postgres', async () => {
    const { pool } = makeScriptedPool();
    const demoIdent = { tenantKey: 'tenant-1', userId: 'u1', demo: true };
    expect(await getTurnStatus(pool, demoIdent, 'tid-1')).toEqual({
      status: 'unknown', supported: false,
    });
  });
});

/**
 * SINGLE ACTIVE TURN PER SESSION, Postgres half (review !62 round 10,
 * Important 3/4).
 *
 * The receipts table added in round 7 already IS this state — 'received' the
 * moment a user turn is persisted, 'answered' when its reply lands — so the guard
 * needs no new table and no migration, and being in the tenant's own database it
 * is correct ACROSS REPLICAS, which a per-process map would not be.
 *
 * The check must sit inside the append's own transaction, behind the session row
 * lock: otherwise two concurrent POSTs can both observe an idle session.
 */
describe('chatStore — single active turn on Postgres (review !62 round 10)', () => {
  const guard = { rejectWhenTurnActive: true };

  it('refuses a second turn while the first receipt is still "received"', async () => {
    const { pool, db } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard),
    ).toBe('appended');
    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('second', 't2')], guard),
    ).toBe('busy');

    // Refused means NOT WRITTEN — no phantom row, and no receipt for the refused
    // turn, so the client's reconciler correctly calls it never-delivered.
    expect(db.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first']);
    expect(db.receipts.map((r) => r.client_turn_id)).toEqual(['t1']);
  });

  it('admits the next turn once the reply flips the receipt to "answered"', async () => {
    const { pool } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);
    // The assistant turn RELEASES the guard, so it is never subject to it.
    await appendTurns(pool, ident('u1'), sessionId, [questionWithId('answer', 't1')]);

    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('second', 't2')], guard),
    ).toBe('appended');
  });

  it('takes the session row lock BEFORE deciding — the check must not be raceable', async () => {
    const { pool, calls } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);
    calls.length = 0;

    await appendTurns(pool, ident('u1'), sessionId, [userWithId('second', 't2')], guard);

    const lockAt = calls.findIndex((q) => q.includes('FOR UPDATE'));
    const probeAt = calls.findIndex((q) => q.includes("status = 'received'"));
    const rollbackAt = calls.indexOf('ROLLBACK');
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeGreaterThan(lockAt);
    // ...and a refusal must END the transaction, never leave it open.
    expect(rollbackAt).toBeGreaterThan(probeAt);
    expect(calls).not.toContain('COMMIT');
  });

  it('does not probe at all when the guard is not asked for', async () => {
    const { pool, calls } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    calls.length = 0;
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')]);
    expect(calls.some((q) => q.includes("status = 'received'"))).toBe(false);
  });

  it('degrades to NO lock on a tenant without the receipts table', async () => {
    // Same policy the rest of this subsystem takes on an older schema — and the
    // reason the client-side guards stay in place rather than being replaced.
    const { pool, script } = makeScriptedPool();
    script.receiptsTable = false;
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);
    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('second', 't2')], guard),
    ).toBe('appended');
  });
});

/**
 * review !62 round 11, Important 2 — three ways the round-10 guard could be
 * bypassed. Its state IS the receipt, so anything that stops a 'received' receipt
 * from existing, or hides one that does, is a hole.
 */
describe('chatStore — the single-active-turn guard cannot be bypassed (round 11)', () => {
  const guard = { rejectWhenTurnActive: true };

  it('refuses a REPLAYED client_turn_id whose receipt is already answered', async () => {
    // The active probe only sees 'received'. An answered id passed it, and the
    // receipt insert's ON CONFLICT DO NOTHING meant no new 'received' row would
    // ever appear for it — so the turn AND the next one went unguarded.
    const { pool, db } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);
    await appendTurns(pool, ident('u1'), sessionId, [questionWithId('answer', 't1')]);

    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('replayed', 't1')], guard),
    ).toBe('duplicate');

    // Nothing written, so the guard is not left blind for the NEXT turn either.
    expect(db.messages.filter((m) => m.content === 'replayed')).toEqual([]);
  });

  it('refuses a replayed id even while its receipt is still "received"', async () => {
    const { pool } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);

    // 'busy' wins here (the session has a turn in flight), which is also correct —
    // what matters is that it is REFUSED.
    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('again', 't1')], guard),
    ).toBe('busy');
  });

  it('FAILS CLOSED when Postgres breaks on a receipts-capable tenant', async () => {
    // The memory buffer knows nothing about the receipt this tenant's other turn
    // wrote, so degrading here would admit a turn that bypassed the lock outright.
    const { pool, script } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    // Answer the first turn so the session is IDLE — otherwise 'busy' would be
    // the (also correct) answer and this would not probe the failure path at all.
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);
    await appendTurns(pool, ident('u1'), sessionId, [questionWithId('answer', 't1')]);

    script.failMessageInsert = true;
    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('second', 't2')], guard),
    ).toBe('unavailable');
  });

  it('still buffers the ASSISTANT turn when Postgres breaks — a reply must never be lost', async () => {
    // The fail-closed rule is for the guarded USER turn only. An assistant turn
    // that already reached the user has to reach the write-behind buffer.
    const { pool, script } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);

    script.failMessageInsert = true;
    expect(
      await appendTurns(pool, ident('u1'), sessionId, [questionWithId('answer', 't1')]),
    ).toBe('appended');
  });

  it('does NOT fail closed on a tenant without receipts — there was no lock to lose', async () => {
    const { pool, script } = makeScriptedPool();
    script.receiptsTable = false;
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    script.failMessageInsert = true;

    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard),
    ).toBe('appended'); // degraded to the memory buffer, as before
  });
});

/**
 * review !62 round 12, Important 3. 003 keyed chat_turn_receipts GLOBALLY on
 * client_turn_id while every check that reads it is scoped by user_id — and the
 * id is a client-minted arbitrary string. The scopes disagreeing is a CROSS-USER
 * defect: B sending a turn under an id A already holds got no receipt of their
 * own, and B's reply then flipped A's receipt to 'answered', releasing A's guard
 * while A's turn was still running.
 */
describe('chatStore — receipts are keyed per user (round 12, Important 3)', () => {
  const guard = { rejectWhenTurnActive: true };

  it('one user\'s turn id does not touch another user\'s receipt', async () => {
    const { pool, db } = makeScriptedPool();

    // A starts a turn under a shared id and is left waiting for its reply.
    const a = await loadHistory(pool, ident('user-A'), null);
    await appendTurns(pool, ident('user-A'), a.sessionId, [userWithId('A works', 'shared-id')], guard);

    // B sends a turn under the SAME id. It is a NEW turn for B, so it is admitted.
    const b = await loadHistory(pool, ident('user-B'), null);
    expect(
      await appendTurns(pool, ident('user-B'), b.sessionId, [userWithId('B works', 'shared-id')], guard),
    ).toBe('appended');
    // B has a receipt OF THEIR OWN — under the global key this INSERT vanished.
    expect(db.receipts.filter((r) => r.client_turn_id === 'shared-id')).toHaveLength(2);

    // B's reply answers B's receipt only.
    await appendTurns(pool, ident('user-B'), b.sessionId, [questionWithId('B done', 'shared-id')]);
    const byUser = Object.fromEntries(
      db.receipts.filter((r) => r.client_turn_id === 'shared-id').map((r) => [r.user_id, r.status]),
    );
    expect(byUser['user-B']).toBe('answered');
    // THE POINT: A is still waiting, so A's guard must still hold.
    expect(byUser['user-A']).toBe('received');
    expect(
      await appendTurns(pool, ident('user-A'), a.sessionId, [userWithId('A again', 'a-2')], guard),
    ).toBe('busy');
  });

  it('treats a GLOBALLY keyed receipts table as absent until 004 is applied', async () => {
    // Using it under the old key is the cross-user hazard above, so the store
    // declines to use it at all rather than half-work.
    const { pool, script } = makeScriptedPool();
    script.receiptsPerUserKey = false;
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);
    // No receipts => no lock (the documented older-schema degradation), and no
    // cross-user collisions either.
    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('second', 't2')], guard),
    ).toBe('appended');
    expect(await getTurnStatus(pool, ident('u1'), 't1')).toEqual({
      status: 'unknown', supported: false,
    });
  });
});

/**
 * review !62 round 12, Important 2. The probe returned all-false on ANY error,
 * which is indistinguishable from "proved absent" — so a settings-DB blip made a
 * receipts-capable tenant look like one with no receipts, and the guarded append
 * degraded to process memory where an already-active Postgres receipt is
 * invisible. On two replicas each could then admit its own turn.
 */
describe('chatStore — an unprobed tenant is not an unguarded one (round 12)', () => {
  const guard = { rejectWhenTurnActive: true };

  it('refuses a guarded turn when the probe fails and nothing is known', async () => {
    const failingPool = {
      connect: async () => { throw new Error('settings DB unreachable'); },
    } as unknown as Pool;

    expect(
      await appendTurns(failingPool, ident('u1'), 'session-1', [userWithId('hi', 't1')], guard),
    ).toBe('unavailable');
  });

  it('still buffers an UNGUARDED turn when the probe fails — a reply is never lost', async () => {
    const failingPool = {
      connect: async () => { throw new Error('settings DB unreachable'); },
    } as unknown as Pool;

    expect(
      await appendTurns(failingPool, ident('u1'), 'session-1', [questionWithId('answer', 't1')]),
    ).toBe('appended');
  });

  it('reuses the LAST KNOWN capability when a later probe fails', async () => {
    // A tenant's schema does not change because their database went briefly
    // unreachable, and the cache was previously consulted only while fresh.
    const { pool, script } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null); // probes: receipts present
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('first', 't1')], guard);
    await appendTurns(pool, ident('u1'), sessionId, [questionWithId('answer', 't1')]);

    // Now the whole connection breaks, expiring nothing but failing every probe.
    script.failMessageInsert = true;
    expect(
      await appendTurns(pool, ident('u1'), sessionId, [userWithId('second', 't2')], guard),
    ).toBe('unavailable'); // known receipts-capable => fail closed, not degrade
  });
});

/**
 * review !62 round 13, Important 1. Round 12 typed awaitingReply as a plain
 * boolean, so every path with no way to answer answered `false`: a tenant whose
 * receipts table is unusable (no 003, or 003 without 004), and a read that failed
 * and degraded to an empty memory buffer. The client treats any boolean as final
 * and stops deriving the state from the transcript — so the one guard those
 * tenants still had was switched off by a claim the server could not back up.
 *
 * `undefined` is the third state: "could not determine". It is what puts the
 * client back on its fallback.
 */
describe('chatStore — awaitingReply is UNKNOWN when it cannot be proved (round 13)', () => {
  const guard = { rejectWhenTurnActive: true };

  it('answers with a boolean when receipts CAN answer', async () => {
    const { pool } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('hi', 't1')], guard);

    const loaded = await loadHistory(pool, ident('u1'), sessionId);
    expect(loaded.awaitingReply).toBe(true);
    expect(loaded.persisted).toBe(true);
  });

  it('says UNKNOWN — not false — on 003 WITHOUT 004', async () => {
    // The globally-keyed receipts table is refused (round 12, Important 3), so
    // there is no state to read. Saying "nothing is running" here is the claim
    // that unlocked a composer whose server-side guard is also off.
    const { pool, script } = makeScriptedPool();
    script.receiptsPerUserKey = false;

    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('hi', 't1')]);

    const loaded = await loadHistory(pool, ident('u1'), sessionId);
    expect(loaded.awaitingReply).toBeUndefined();
    // The transcript still loads, and still shows the unanswered turn the client
    // will now derive its own verdict from.
    expect(loaded.persisted).toBe(true);
    expect(loaded.history.map((t) => t.content)).toEqual(['hi']);
  });

  it('says UNKNOWN when the tenant has no receipts table at all', async () => {
    const { pool, script } = makeScriptedPool();
    script.receiptsTable = false;

    const loaded = await loadHistory(pool, ident('u1'), null);
    expect(loaded.awaitingReply).toBeUndefined();
    expect(loaded.persisted).toBe(true);
  });

  it('says UNKNOWN when the active-turn read FAILS, and still returns the transcript', async () => {
    const { pool, script } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);
    await appendTurns(pool, ident('u1'), sessionId, [userWithId('hi', 't1')], guard);

    script.failActiveTurnProbe = true;
    const loaded = await loadHistory(pool, ident('u1'), sessionId);

    expect(loaded.awaitingReply).toBeUndefined();
    // Letting that read throw would degrade the WHOLE load to memory, which for a
    // real user is an empty buffer — answering "nothing is running" with even less
    // basis, and losing the history too.
    expect(loaded.persisted).toBe(true);
    expect(loaded.history.map((t) => t.content)).toEqual(['hi']);
  });

  it('says UNKNOWN when the whole read fails and it degrades to memory', async () => {
    const failingPool = {
      connect: async () => { throw new Error('settings DB unreachable'); },
    } as unknown as Pool;

    const loaded = await loadHistory(failingPool, ident('u1'), null);
    expect(loaded.awaitingReply).toBeUndefined();
    expect(loaded.persisted).toBe(false);
  });

  it('STILL answers authoritatively when memory legitimately IS the store', async () => {
    // A demo identity, or a tenant without the chat tables, has no Postgres to
    // consult — the buffer is the whole truth, so it can speak for itself.
    const demo = { tenantKey: 'tenant-1', userId: 'u1', demo: true };
    const { sessionId } = await loadHistory(null, demo, null);
    await appendTurns(null, demo, sessionId, [userWithId('hi', 't1')], guard);

    const loaded = await loadHistory(null, demo, null);
    expect(loaded.awaitingReply).toBe(true);
  });
});

describe('chatStore — a stored result row is served without its artifact URL (round 16)', () => {
  // Placeholder bucket and job id: this repo is mirrored publicly.
  const URL = 's3://example-dashboard-artifacts-0000/jobs/'
    + '11111111-2222-4333-8444-555555555555/report_schema.json';
  const dashboard = { title: 'Driver Mileage', report_schema: { title: 'Driver Mileage' } };
  const savedReply: AgentTurn = {
    role: 'assistant',
    type: 'result',
    content: [
      'Built it! 🎉',
      '',
      `| **Download URL** | \`${URL}\` |`,
      '',
      'To download it locally, you can run:',
      '```bash',
      `aws s3 cp ${URL} ./report_schema.json`,
      '```',
    ].join('\n'),
    result: dashboard,
  };

  it('keeps the row exactly as written, and strips it on the way to the browser', async () => {
    const { pool, db } = makeScriptedPool();
    const { sessionId } = await loadHistory(pool, ident('u1'), null);

    // Written the way a pre-round-16 backend wrote it — the agent's prose verbatim.
    await appendTurns(pool, ident('u1'), sessionId, [user('build it'), savedReply]);

    // THE ROW IS UNTOUCHED. No migration, no backfill: the record still holds
    // what the agent said, so the rule can be revisited without data loss.
    expect(db.messages[1].content).toContain(URL);

    // And rowToTurn still hands it back verbatim — the store is not where this is
    // fixed, which is exactly why serializing it raw was a leak.
    const loaded = await loadHistory(pool, ident('u1'), sessionId);
    expect(loaded.persisted).toBe(true);
    expect(loaded.history[1].content).toContain(URL);

    // The wire body is where it goes.
    const body = buildSessionResponse(loaded);
    expect(JSON.stringify(body)).not.toContain('s3://');
    expect(JSON.stringify(body)).not.toContain('example-dashboard-artifacts');
    expect(body.messages[1].content).toBe('Built it! 🎉');
    expect(body.messages[1].result).toEqual(dashboard); // Preview still works
    expect(body.messages[0]).toEqual(user('build it'));
  });
});

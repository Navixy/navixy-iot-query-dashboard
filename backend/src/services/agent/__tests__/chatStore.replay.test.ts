import { describe, it, expect, afterEach, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { loadHistory, appendTurns, getTurnStatus, __resetChatStoreForTests } from '../chatStore.js';
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
    receipts: [] as Array<{ client_turn_id: string; user_id: string; status: string }>,
  };
  const script: Script = {
    tablesExist: true,
    clientTurnIdColumn: true,
    receiptsTable: true,
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

      // Durable receipts (round 7, finding 5b). Applied directly, not txn-buffered:
      // insertEntry only writes a receipt AFTER a successful message INSERT, and the
      // ON CONFLICT clauses make replay idempotent, so buffer fidelity is not needed.
      if (q.includes('INSERT INTO dashboard_studio_meta_data.chat_turn_receipts')) {
        const id = String(params[0]);
        const answered = q.includes("'answered'");
        const existing = db.receipts.find((r) => r.client_turn_id === id);
        if (existing) {
          if (q.includes('DO UPDATE')) existing.status = 'answered';
          // else ON CONFLICT DO NOTHING
        } else {
          db.receipts.push({
            client_turn_id: id, user_id: String(params[1]),
            status: answered ? 'answered' : 'received',
          });
        }
        return { rows: [] };
      }
      if (q.startsWith('DELETE FROM dashboard_studio_meta_data.chat_turn_receipts')) {
        // Age-based prune; the stub has no clock, so nothing is old enough — no-op.
        return { rows: [], rowCount: 0 };
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

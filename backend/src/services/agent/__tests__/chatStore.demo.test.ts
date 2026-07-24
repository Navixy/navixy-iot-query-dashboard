import { describe, it, expect, afterEach, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { loadHistory, appendTurns, __resetChatStoreForTests } from '../chatStore.js';
import type { ChatIdentity } from '../chatStore.js';
import type { AgentTurn } from '../types.js';

/**
 * Demo isolation (review !62 round 2, Critical 1): demo and real sessions of the
 * SAME tenant + user must never share storage. Before the ident.demo namespace,
 * both modes resolved to one `${tenantKey}:${userId}` buffer, so (a) demo read
 * the real user's degraded-mode history, and (b) demo turns sat in the
 * write-behind buffer and were REPLAYED into the tenant's Postgres on the next
 * healthy real-mode touch — persisted rows from a mode that promises "no
 * modifications will be saved to the database".
 *
 * The reviewer's repro sequences are pinned here in both directions, plus the
 * store-level enforcement: a demo identity handed a live pool (a route wiring
 * bug) must still never touch it.
 */

const real = (userId: string, tenantKey = 'tenant-1'): ChatIdentity =>
  ({ tenantKey, userId, demo: false });
const demo = (userId: string, tenantKey = 'tenant-1'): ChatIdentity =>
  ({ tenantKey, userId, demo: true });

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
  client_turn_id: string | null;
  at: number;
}

/** Minimal healthy-Postgres protocol stub — the same SQL surface the replay suite
 *  scripts, without its failure knobs. Self-contained per house test style. */
function makeHealthyPool() {
  const db = {
    sessions: [] as Array<{ id: string; user_id: string; created_at: number }>,
    messages: [] as MsgRow[],
    receipts: [] as Array<{ client_turn_id: string; user_id: string; status: string }>,
  };
  let mintedSession = 0;
  let txn: MsgRow[] | null = null;
  let connects = 0;

  const client = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
      const q = sql.replace(/\s+/g, ' ').trim();

      if (q === 'BEGIN') { txn = []; return { rows: [] }; }
      if (q === 'COMMIT') { db.messages.push(...(txn ?? [])); txn = null; return { rows: [] }; }
      if (q === 'ROLLBACK') { txn = null; return { rows: [] }; }

      // Column probe (review !62 round 6) — matched before the tables probe.
      if (q.includes('information_schema.columns')) return { rows: [{ exists: true }] };
      if (q.includes('information_schema.tables')) return { rows: [{ exists: true }] };

      if (q.includes('INSERT INTO dashboard_studio_meta_data.chat_sessions')) {
        const userId = String(params[0]);
        if (db.sessions.some((s) => s.user_id === userId)) return { rows: [] };
        const row = {
          id: `00000000-0000-4000-8000-${String(++mintedSession).padStart(12, '0')}`,
          user_id: userId, created_at: mintedSession,
        };
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
        // With the round-6 client_turn_id column present (this pool probes it as
        // existing), the INSERT carries 9 params — (…, result, client_turn_id, at).
        const withColumn = params.length === 9;
        const row: MsgRow = {
          id: String(params[0]), session_id: String(params[1]), user_id: String(params[2]),
          role: String(params[3]), content: String(params[4]),
          type: params[5] === null ? null : String(params[5]),
          result: params[6] === null ? null : String(params[6]),
          client_turn_id: withColumn && params[7] !== null ? String(params[7]) : null,
          at: Number(withColumn ? params[8] : params[7]),
        };
        if (db.messages.some((m) => m.id === row.id) || (txn ?? []).some((m) => m.id === row.id)) {
          return { rows: [] };
        }
        (txn ?? db.messages).push(row);
        return { rows: [] };
      }

      if (q.includes('UPDATE dashboard_studio_meta_data.chat_sessions')) return { rows: [] };

      // Durable receipts (round 7). These tests never expect Postgres writes for
      // demo idents, so this only matters for the real-mode identity's turns.
      if (q.includes('INSERT INTO dashboard_studio_meta_data.chat_turn_receipts')) {
        const id = String(params[0]);
        const answered = q.includes("'answered'");
        const existing = db.receipts.find((r) => r.client_turn_id === id);
        if (existing) {
          if (q.includes('DO UPDATE')) existing.status = 'answered';
        } else {
          db.receipts.push({
            client_turn_id: id, user_id: String(params[1]),
            status: answered ? 'answered' : 'received',
          });
        }
        return { rows: [] };
      }
      if (q.startsWith('DELETE FROM dashboard_studio_meta_data.chat_turn_receipts')) {
        return { rows: [] };
      }

      if (q.includes('FROM dashboard_studio_meta_data.chat_messages')) {
        const rows = db.messages
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

  const pool = {
    connect: async () => { connects++; return client; },
  } as unknown as Pool;
  return { pool, db, connectCount: () => connects };
}

afterEach(() => {
  __resetChatStoreForTests();
  jest.restoreAllMocks();
});

describe('chatStore — demo isolation (review !62 round 2)', () => {
  it('real-fallback then demo: demo sees an EMPTY history and its own session, never the buffered real turns', async () => {
    // Real mode, settings DB unavailable — the turn lands in the write-behind buffer.
    const realLoad = await loadHistory(null, real('u1'), null);
    await appendTurns(null, real('u1'), realLoad.sessionId, [user('real degraded turn')]);

    // The same tenant + user opens a demo session.
    const demoLoad = await loadHistory(null, demo('u1'), null);
    expect(demoLoad.history).toEqual([]);
    expect(demoLoad.sessionId).not.toBe(realLoad.sessionId); // the reviewer's repro pinned sameSession=true
    expect(demoLoad.persisted).toBe(false);

    // And the real buffer is still intact for the real session.
    const realAgain = await loadHistory(null, real('u1'), realLoad.sessionId);
    expect(realAgain.history).toEqual([user('real degraded turn')]);
  });

  it('demo then real-recovery: the healthy replay drains ONLY the real buffer — demo turns never reach Postgres', async () => {
    // Demo dialogue happens first (in memory, demo namespace)...
    const demoLoad = await loadHistory(null, demo('u1'), null);
    await appendTurns(null, demo('u1'), demoLoad.sessionId, [
      user('demo-only prompt'), question('demo-only reply'),
    ]);
    // ...and a real degraded turn is buffered alongside it (live namespace).
    const realLoad = await loadHistory(null, real('u1'), null);
    await appendTurns(null, real('u1'), realLoad.sessionId, [user('real buffered turn')]);

    // Postgres comes back for real mode: the replay must pick up the real buffer
    // and ONLY the real buffer.
    const { pool, db } = makeHealthyPool();
    const recovered = await loadHistory(pool, real('u1'), null);
    expect(recovered.persisted).toBe(true);
    expect(recovered.history).toEqual([user('real buffered turn')]);
    expect(db.messages.map((m) => m.content)).toEqual(['real buffered turn']);

    // The demo transcript is untouched — still served, still memory-only.
    const demoAfter = await loadHistory(null, demo('u1'), demoLoad.sessionId);
    expect(demoAfter.persisted).toBe(false);
    expect(demoAfter.history).toEqual([
      user('demo-only prompt'), question('demo-only reply'),
    ]);
  });

  it('a demo identity handed a live pool still never touches it (store-level enforcement)', async () => {
    const { pool, db, connectCount } = makeHealthyPool();

    // Seed a real persisted turn so a leak would be observable on read.
    const realLoad = await loadHistory(pool, real('u1'), null);
    await appendTurns(pool, real('u1'), realLoad.sessionId, [user('persisted real turn')]);
    const connectsAfterReal = connectCount();

    // A buggy caller passes the pool for a demo request. The store must refuse it:
    // no reads of the persisted transcript, no writes, not even a probe.
    const demoLoad = await loadHistory(pool, demo('u1'), null);
    expect(demoLoad.persisted).toBe(false);
    expect(demoLoad.history).toEqual([]);
    await appendTurns(pool, demo('u1'), demoLoad.sessionId, [user('demo turn')]);
    expect(connectCount()).toBe(connectsAfterReal);
    expect(db.messages.map((m) => m.content)).toEqual(['persisted real turn']);
  });
});

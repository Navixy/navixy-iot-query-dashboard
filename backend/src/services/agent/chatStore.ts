/**
 * Chat transcript store for the AI dashboard agent (DO-313).
 *
 * Three properties define this file:
 *
 * 1. IT NEVER THROWS AND NEVER 500s. Missing tables, revoked grants, a settings DB
 *    briefly routed to a read-only standby — every failure is caught, logger.warn'ed
 *    once, and degraded to the bounded in-memory path. A tenant whose DBA has not
 *    applied 002_add_chat_tables.sql still gets a working chat; they just lose the
 *    transcript on reload.
 *
 * 2. IT IS DISPLAY-ONLY. The transcript is (a) what GET /api/agent/session rehydrates
 *    into the UI and (b) the mock's turn counter. It is NEVER sent to Bedrock: under
 *    AGENT_BACKEND=bedrock the implementation ignores input.history entirely (D19) —
 *    Bedrock keys conversation memory server-side on sessionId. Consequence: with no
 *    tables applied, the transcript is lost on reload but THE AGENT STILL REMEMBERS,
 *    which makes the fallback MORE graceful than it was designed to be.
 *
 * 3. IT STORES THE FULL DASHBOARD JSON, NEVER A URL — see the persist-never-refetch
 *    rule above appendTurns. This is load-bearing (§3.4.6).
 *
 * There is no migration runner in this repo (001_add_composite_reports.sql proves the
 * path rots silently), so the store probes information_schema per tenant — the house
 * convention (services/database.ts:610, :667, :730) — and caches the answer per pool
 * for a short TTL.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { logger } from '../../utils/logger.js';
import { isTransientDbError, toErrorMeta } from '../../utils/errors.js';
import type { AgentChatResult, AgentTurn } from './types.js';

export interface ChatStoreResult {
  sessionId: string;
  history: AgentTurn[];
  persisted: boolean;
}

/** In-memory bounds. Unbounded fallbacks are SILENT leaks, so every axis is capped:
 *  session count (oldest-first eviction), turns per session (oldest dropped — the
 *  COUNT is capped, never the payload, so surviving result turns keep their full
 *  report_schema; see B4-R6), and age (lazy sweep on write). */
const MAX_SESSIONS = 500;
const MAX_TURNS = 100;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

/** Probe cache TTL: short enough that a DBA applying the DDL sees history go live
 *  within a minute with no restart, long enough that it is not a per-request
 *  round trip. */
const PROBE_TTL_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MemorySession {
  sessionId: string;
  turns: AgentTurn[];
  /** Last write (or creation). Feeds both the TTL sweep and oldest-first eviction. */
  updatedAt: number;
}

/** Keyed by userId — DO-313 v1 is one continuous dialogue per user (D7), mirroring
 *  the chat_sessions_one_active_per_user partial unique index. PER-PROCESS: with
 *  more than one replica, in-memory history is sticky-session-dependent.
 *  docker-compose runs a single backend, so this is acceptable for v1 — and is a
 *  concrete reason to land the DDL. */
let memorySessions = new Map<string, MemorySession>();

/** Probe result per tenant. The spec asked for Map<sha256(userDbUrl), …>, but this
 *  module is handed a Pool, not a URL — and DatabaseService.getClientSettingsPool
 *  returns ONE cached Pool instance per tenant and already keys per-tenant state
 *  off the pool object itself (settingsPoolKeys, database.ts:75). Keying on pool
 *  identity gives the same per-tenant granularity with NO URL — and therefore no
 *  password — anywhere in this module (B4-R5), and a recreated pool (password
 *  rotation) starts with a fresh probe, which is correct. */
let probeCache = new WeakMap<Pool, { exists: boolean; checkedAt: number }>();

/** Test-only: clears the in-memory sessions and the probe cache so suites are
 *  order-independent. Production never calls it. */
export function __resetChatStoreForTests(): void {
  memorySessions = new Map();
  probeCache = new WeakMap();
}

/** Local replica of DatabaseService's private withSettingsDbRetry (database.ts:523):
 *  retry a transient CONNECTIVITY failure a couple of times with small backoff, throw
 *  everything else immediately. IDEMPOTENT OPERATIONS ONLY — never wrap the message
 *  INSERTs with this. Replicated rather than imported because the original is a
 *  private method of DatabaseService and this store deliberately depends only on the
 *  Pool it is handed; the transient classifier is the shared exported one. */
async function withTransientRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientDbError(error)) throw error;
      const delayMs = attempt * 150;
      logger.warn('Transient settings-DB error; retrying', {
        label, attempt, maxAttempts, delayMs, error: toErrorMeta(error).message,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** Probe BOTH tables — a half-applied migration must degrade, not half-work. Never
 *  throws: an unreachable settings DB is not "tables missing", so that failure
 *  degrades THIS request without being cached, and persistence resumes the moment
 *  the DB does (house precedent: getGlobalVariables degrades per request and caches
 *  success only). */
async function chatTablesExist(pool: Pool): Promise<boolean> {
  const now = Date.now();
  const cached = probeCache.get(pool);
  if (cached && now - cached.checkedAt < PROBE_TTL_MS) return cached.exists;

  try {
    const exists = await withTransientRetry('chatStore.probe', async () => {
      const client = await pool.connect();
      try {
        const sessionsExist = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'dashboard_studio_meta_data'
            AND table_name = 'chat_sessions'
          )
        `);
        if (!sessionsExist.rows[0].exists) {
          logger.warn('chat_sessions table does not exist in dashboard_studio_meta_data schema');
          return false;
        }

        const messagesExist = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'dashboard_studio_meta_data'
            AND table_name = 'chat_messages'
          )
        `);
        if (!messagesExist.rows[0].exists) {
          logger.warn('chat_messages table does not exist in dashboard_studio_meta_data schema');
          return false;
        }

        return true;
      } finally {
        client.release();
      }
    });
    probeCache.set(pool, { exists, checkedAt: now });
    return exists;
  } catch (error) {
    logger.warn('chat tables probe failed; degrading to in-memory history', {
      error: toErrorMeta(error).message,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

function sweepExpired(now: number): void {
  for (const [userId, session] of memorySessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) memorySessions.delete(userId);
  }
}

function evictIfOverflow(): void {
  while (memorySessions.size > MAX_SESSIONS) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, session] of memorySessions) {
      if (session.updatedAt < oldestAt) {
        oldestAt = session.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    memorySessions.delete(oldestKey);
  }
}

function memoryResolveOrCreate(userId: string): MemorySession {
  // CONCURRENCY GUARD: the Postgres path makes first-turn get-or-create race-safe via
  // the chat_sessions_one_active_per_user partial unique index + ON CONFLICT DO
  // NOTHING. This map has no such constraint, so the guarantee here is that the
  // lookup and the insert run in ONE synchronous tick — there is no await between the
  // .get and the .set — and two concurrent turn-1 requests therefore cannot both miss
  // and mint two sessions. Reachable in practice only if the composer's
  // disabled-while-pending rule is bypassed, but it costs three lines.
  const now = Date.now();
  sweepExpired(now); // TTL is swept lazily on write (and a create IS a write)
  const existing = memorySessions.get(userId);
  if (existing) return existing;

  const created: MemorySession = { sessionId: randomUUID(), turns: [], updatedAt: now };
  memorySessions.set(userId, created);
  evictIfOverflow();
  return created;
}

/** The supplied session_id is deliberately not consulted here: one dialogue per user
 *  (D7) means the user's own live session IS the resolution for any id — unknown,
 *  expired or foreign ids silently land on it (D13). Never throws. */
function memoryLoad(userId: string): ChatStoreResult {
  const session = memoryResolveOrCreate(userId);
  return { sessionId: session.sessionId, history: [...session.turns], persisted: false };
}

function memoryAppend(userId: string, sessionId: string, turns: AgentTurn[]): void {
  const now = Date.now();
  sweepExpired(now);
  let session = memorySessions.get(userId);
  if (!session) {
    // A degraded Postgres append (e.g. read-only standby) lands here carrying a
    // Postgres-minted sessionId. Adopt it: if the outage persists, the next
    // loadHistory degrades too, resolves this session and the transcript survives.
    session = { sessionId, turns: [], updatedAt: now };
    memorySessions.set(userId, session);
    evictIfOverflow();
  } else if (session.sessionId !== sessionId) {
    // The id from THIS request's loadHistory is authoritative (D13). Same user,
    // same single dialogue (D7) — keep the turns, adopt the newer id.
    session.sessionId = sessionId;
  }
  session.turns.push(...turns);
  if (session.turns.length > MAX_TURNS) {
    session.turns.splice(0, session.turns.length - MAX_TURNS);
  }
  session.updatedAt = now;
}

// ---------------------------------------------------------------------------
// Postgres path
// ---------------------------------------------------------------------------

/** Session resolution — THE SERVER IS AUTHORITATIVE (D13). A supplied id is validated
 *  against (id, user_id, is_deleted = FALSE); on miss, the user's single active
 *  session; else INSERT … ON CONFLICT DO NOTHING RETURNING id and, on an empty
 *  return, re-SELECT (the partial unique index makes this race-safe). An unknown,
 *  expired or foreign session_id silently yields a live session. NEVER 400, NEVER 404. */
async function resolveSession(
  client: PoolClient, userId: string, sessionId: string | null,
): Promise<string> {
  // chat_sessions.id is a uuid column: comparing a non-UUID string against it makes
  // Postgres throw 22P02 before any row is checked. A malformed id is just a miss
  // (D13), so it skips the lookup instead of erroring — and never burns a retry on a
  // deterministic fault.
  if (sessionId && UUID_RE.test(sessionId)) {
    const owned = await client.query(
      `SELECT id FROM dashboard_studio_meta_data.chat_sessions
        WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [sessionId, userId],
    );
    if (owned.rows.length > 0) return String(owned.rows[0].id);
  }

  // ORDER BY … LIMIT 1 is defensive: the partial unique index guarantees at most one
  // active session, but a tenant that applied the tables WITHOUT the index (a
  // half-applied 002) must still resolve deterministically — newest wins.
  const active = await client.query(
    `SELECT id FROM dashboard_studio_meta_data.chat_sessions
      WHERE user_id = $1 AND is_deleted = FALSE
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  if (active.rows.length > 0) return String(active.rows[0].id);

  const inserted = await client.query(
    `INSERT INTO dashboard_studio_meta_data.chat_sessions (user_id)
     VALUES ($1)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId],
  );
  if (inserted.rows.length > 0) return String(inserted.rows[0].id);

  // Lost the get-or-create race: a concurrent INSERT won under the partial unique
  // index. The winner's row is committed, so the re-SELECT finds it.
  const raced = await client.query(
    `SELECT id FROM dashboard_studio_meta_data.chat_sessions
      WHERE user_id = $1 AND is_deleted = FALSE
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  if (raced.rows.length > 0) return String(raced.rows[0].id);

  // Unreachable unless the table is being mutated out-of-band mid-request; the
  // throw is caught by loadHistory's degrade and never escapes.
  throw new Error('chat session get-or-create yielded no row');
}

interface ChatMessageRow {
  role: string;
  type: string | null;
  content: string;
  result: unknown;
}

/** Maps a chat_messages row onto the AgentTurn union (§3.1). Legacy rows (type NULL)
 *  and — defensively — a 'result' row whose payload is missing render as plain
 *  assistant prose, i.e. the 'question' arm with `type` absent. */
function rowToTurn(row: ChatMessageRow): AgentTurn {
  if (row.role === 'user') {
    return { role: 'user', content: row.content };
  }
  if (row.type === 'result' && row.result && typeof row.result === 'object') {
    return {
      role: 'assistant',
      type: 'result',
      content: row.content,
      result: row.result as AgentChatResult,
    };
  }
  if (row.type === 'question' || row.type === 'error') {
    return { role: 'assistant', type: row.type, content: row.content, result: null };
  }
  return { role: 'assistant', content: row.content, result: null };
}

async function pgLoadHistory(
  pool: Pool, userId: string, sessionId: string | null,
): Promise<ChatStoreResult> {
  // Wrapped in the transient retry like getGlobalVariables' whole read path
  // (database.ts:660): everything inside is idempotent — the INSERT arm is
  // get-or-create under ON CONFLICT DO NOTHING, so a retry lands on the re-SELECT.
  return withTransientRetry('chatStore.loadHistory', async () => {
    const client = await pool.connect();
    try {
      const resolved = await resolveSession(client, userId, sessionId);

      // Cap the COUNT of turns on read — a long transcript cannot blow the response
      // size. Result turns keep their full `result` payload: stripping dashboards
      // would be the failure D16 exists to prevent (an assistant claiming it built a
      // dashboard with no way to preview it). Newest MAX_TURNS, returned oldest-first.
      const rows = await client.query(
        `SELECT role, type, content, result
           FROM dashboard_studio_meta_data.chat_messages
          WHERE session_id = $1 AND user_id = $2
          ORDER BY created_at DESC
          LIMIT $3`,
        [resolved, userId, MAX_TURNS],
      );
      const history = (rows.rows as ChatMessageRow[]).reverse().map(rowToTurn);
      return { sessionId: resolved, history, persisted: true };
    } finally {
      client.release();
    }
  });
}

async function pgAppendTurns(
  pool: Pool, userId: string, sessionId: string, turns: AgentTurn[],
): Promise<void> {
  // A WRITE — deliberately NOT wrapped in withTransientRetry (idempotent reads only:
  // a retried INSERT would duplicate the turn).
  const client = await pool.connect();
  try {
    for (const turn of turns) {
      const type = turn.role === 'assistant' ? turn.type ?? null : null;
      const result =
        turn.role === 'assistant' && turn.type === 'result'
          ? JSON.stringify(turn.result)
          : null;
      if (result !== null) {
        // §3.4.6's size budget (~5-50 KB per result turn) is observable if it drifts.
        logger.info('Persisting agent result turn', {
          sessionId,
          resultBytes: Buffer.byteLength(result),
        });
      }
      await client.query(
        `INSERT INTO dashboard_studio_meta_data.chat_messages
           (session_id, user_id, role, content, type, result)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sessionId, userId, turn.role, turn.content, type, result],
      );
    }
    await client.query(
      `UPDATE dashboard_studio_meta_data.chat_sessions
          SET updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Resolve the caller's session and return its transcript, newest MAX_TURNS,
 *  oldest-first. NEVER rejects: a null pool, missing tables or any Postgres failure
 *  degrades to the bounded in-memory path with persisted: false. */
export async function loadHistory(
  pool: Pool | null, userId: string, sessionId: string | null,
): Promise<ChatStoreResult> {
  if (pool) {
    try {
      if (await chatTablesExist(pool)) {
        return await pgLoadHistory(pool, userId, sessionId);
      }
    } catch (error) {
      logger.warn('chatStore.loadHistory degraded to in-memory history', {
        error: toErrorMeta(error).message,
      });
    }
  }
  return memoryLoad(userId);
}

/**
 * THE PERSIST-NEVER-REFETCH RULE (§3.4.6). appendTurns writes the assistant turn's
 * AgentChatResult — {title, report_schema} with the COMPLETE dashboard JSON — into
 * the `result` jsonb column. NEVER the s3:// URL. The artifact is fetched exactly
 * once, by the Bedrock service, at the moment the turn is produced. Preview, Apply,
 * history load and page reload all read from here and NEVER touch S3.
 *
 * Three reasons, in order of weight: EXPIRY (artifacts live "a few months"; a saved
 * conversation outlives that), IMMUTABILITY (nothing guarantees the S3 object is
 * never rewritten, and if it is, the thing the user approves is not the thing they
 * reviewed — which voids the entire preview-before-Apply argument), and
 * LATENCY / BLAST RADIUS (235 ms and an AWS dependency on a pure UI click, plus an
 * S3 outage breaking re-previews of conversations that completed days ago).
 *
 * Size budget: ~5-50 KB per result turn (the observed artifact is 5385 bytes). That
 * is well within reason and is the intended use of the column. Do NOT add a
 * compression step, a size cap or a separate blob table for v1; the serialized byte
 * length is logged on write so the budget is observable if it ever drifts.
 *
 * A NoSuchKey at preview time after this rule is in force is A BUG IN THE
 * MITIGATION, and should be alarming, not routine.
 *
 * NEVER rejects: any Postgres failure (including a read-only standby refusing the
 * INSERT) degrades to the in-memory path so the transcript stays coherent for this
 * process; the turn itself already reached the user in the HTTP response.
 */
export async function appendTurns(
  pool: Pool | null, userId: string, sessionId: string, turns: AgentTurn[],
): Promise<void> {
  if (pool) {
    try {
      if (await chatTablesExist(pool)) {
        await pgAppendTurns(pool, userId, sessionId, turns);
        return;
      }
    } catch (error) {
      logger.warn('chatStore.appendTurns degraded to in-memory history', {
        error: toErrorMeta(error).message,
      });
    }
  }
  memoryAppend(userId, sessionId, turns);
}

/**
 * Chat transcript store for the AI dashboard agent (DO-313).
 *
 * Three properties define this file:
 *
 * 1. IT NEVER THROWS AND NEVER 500s. Missing tables, revoked grants, a settings DB
 *    briefly routed to a read-only standby — every failure is caught, logger.warn'ed
 *    once, and degraded to the bounded in-memory path. The memory path is a
 *    WRITE-BEHIND BUFFER (MR !61 review): the next healthy Postgres touch replays
 *    it into the resolved session, so a mid-dialogue outage no longer forfeits the
 *    turns it swallowed — a tenant whose DBA has not applied
 *    002_add_chat_tables.sql still gets a working chat, and the transcript now
 *    survives INTO Postgres once the DDL lands. DEMO identities are the exception
 *    (review !62 round 2): they live in their own memory namespace, never reach
 *    Postgres and never join the replay — see ChatIdentity.demo.
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
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { logger } from '../../utils/logger.js';
import { isTransientDbError, toErrorMeta } from '../../utils/errors.js';
import { settingsPoolKeyForUrl } from '../dbIdentity.js';
import type { AgentChatResult, AgentTurn } from './types.js';

export interface ChatStoreResult {
  sessionId: string;
  history: AgentTurn[];
  persisted: boolean;
}

/**
 * WHO a transcript belongs to. userId ALONE IS NOT AN IDENTITY (MR !61 review,
 * Critical): it is the tenant database's own users.id — unique only within that
 * database — and login trusts whatever userDbUrl the caller presents, so a hostile
 * tenant can mint a JWT for any userId by pre-seeding a row with a chosen id in a
 * database they own. Every piece of CROSS-TENANT SHARED STATE in this process (the
 * in-memory fallback here, the rate-limit bucket in routes/agent.ts) must therefore
 * be scoped by tenant + user, never bare userId.
 *
 * The Postgres path needs no such scoping — each tenant's pool IS their own database.
 */
export interface ChatIdentity {
  /** Tenant scope — tenantKeyFor(userDbUrl): a hash of the NORMALIZED pool
   *  identity, so every equivalent spelling of one settings DB maps to one key
   *  (MR !61 round 3). Opaque: never the URL itself, so no password enters this
   *  module or any map key (B4-R5). */
  tenantKey: string;
  userId: string;
  /** True for demo-mode requests. Demo transcripts live in a SEPARATE memory
   *  namespace and NEVER touch Postgres (review !62 round 2, Critical 1): without
   *  this split, demo shared `${tenantKey}:${userId}` with a degraded real-mode
   *  session — demo read the real user's buffered history, demo turns landed in
   *  the same write-behind buffer, and the next healthy real-mode touch REPLAYED
   *  them into the tenant's database, breaking the demo promise that nothing is
   *  saved. The store enforces both properties itself (memKey below, and the
   *  pool override in loadHistory/appendTurns) instead of trusting every caller
   *  to remember to pass pool = null. */
  demo: boolean;
}

/** sha256 of the tenant's NORMALIZED pool identity (settingsPoolKeyForUrl:
 *  `settings:user@host:port/database`) — NOT of the raw URL string. Raw-string
 *  hashing keyed state per SPELLING, and parsePostgresUrl ignores every query
 *  parameter except sslmode, so ?application_name=1, =2, … each minted a fresh
 *  20/min rate-limit bucket while landing on the SAME pool — a working bypass —
 *  and password rotation orphaned the fallback transcript (MR !61 round 3, note
 *  56573). Round 4 (note 56582) extended the normalization to DNS-equivalent
 *  hostname spellings — case, trailing root dot, numeric IPv4 forms — inside
 *  parsePostgresUrl itself. Merging spellings is safe precisely because the pool
 *  merges them: same user@host:port/database IS the same physical database, i.e.
 *  the same tenant. Isolation across real tenants is untouched — different host,
 *  database or DB user still split. Hashing keeps the key opaque and
 *  password-free (B4-R5).
 *
 *  Derived per call, DELIBERATELY unmemoized (round 4): a memo keyed by the raw
 *  URL retained plaintext passwords — rotated-out ones included — in process
 *  memory for the cache's whole lifetime, and the memo only ever existed to
 *  sidestep the parser's per-call logging, which is gone. What remains is one
 *  URL parse and one sha256 — nothing worth caching a credential for. */
export function tenantKeyFor(userDbUrl: string): string {
  let canonical: string;
  try {
    canonical = settingsPoolKeyForUrl(userDbUrl);
  } catch {
    // Unreachable for a URL that passed login (the parse is deterministic and login
    // already ran it), but the limiter's keyGenerator MUST NOT throw: the error
    // would surface through errorHandler as a 500 on every chat request. Hashing
    // the raw string is strictly FINER-grained: never weaker isolation, only more
    // buckets. The prefixes keep the namespaces disjoint ('settings:' vs 'raw:').
    canonical = `raw:${userDbUrl}`;
  }
  return createHash('sha256').update(canonical).digest('hex');
}

/** In-memory bounds. Unbounded fallbacks are SILENT leaks, so every axis is capped:
 *  session count (oldest-first eviction), turns per session (oldest dropped — the
 *  COUNT is capped, never the payload, so surviving result turns keep their full
 *  report_schema; see B4-R6), age (lazy sweep on write) — and BYTES (MR !61
 *  review): the count caps alone still admitted ~250 MiB per session (100 turns
 *  can hold ~50 results at the 5 MiB artifact cap) and hundreds of GiB across 500
 *  sessions. Byte budgets evict whole oldest turns/sessions the same way; a
 *  retained payload is never truncated. 8 MiB comfortably holds the largest single
 *  admissible turn (a 5 MiB artifact plus prose) with room for the dialogue around
 *  it; 64 MiB bounds what a DEGRADED fallback may reasonably claim of the process
 *  heap. Sizes are serialized-turn byte lengths, computed once per buffered turn. */
const MAX_SESSIONS = 500;
const MAX_TURNS = 100;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

/** Probe cache TTL: short enough that a DBA applying the DDL sees history go live
 *  within a minute with no restart, long enough that it is not a per-request
 *  round trip. */
const PROBE_TTL_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A turn plus the identity it carries through EVERY store (MR !61 review). */
interface StoredTurn {
  /** Minted ONCE, when the turn enters the store, and carried through memory and
   *  Postgres alike: the message INSERT is `ON CONFLICT (id) DO NOTHING`, which
   *  makes replaying a buffered turn idempotent even across an in-doubt COMMIT
   *  (connection lost after the server applied it — the classic case where
   *  "just retry the INSERT" duplicates the row). */
  id: string;
  /** Entry wall-clock (ms) — becomes the Postgres row's created_at, so a replayed
   *  outage buffer keeps truthful timestamps and total order instead of collapsing
   *  onto one transaction NOW(). Nudged strictly monotonic within a batch and
   *  within a session buffer; across separate requests the agent's multi-second
   *  latency dwarfs any clock jitter. */
  at: number;
  turn: AgentTurn;
  /** Serialized size — computed once, lazily, when the turn enters the BUFFER
   *  (never on the Postgres happy path, which would stringify twice for nothing). */
  bytes?: number;
}

interface MemorySession {
  sessionId: string;
  /** For a pooled tenant this doubles as the WRITE-BEHIND BUFFER: by construction
   *  every entry here is absent from Postgres (a turn is buffered only when its
   *  Postgres write failed or the tables are missing), which is the invariant that
   *  makes blind replay safe. Bounded by MAX_TURNS and MAX_SESSION_BYTES — an
   *  outage longer than those loses oldest turns, the same bound the pure-memory
   *  tenant already lives with. */
  entries: StoredTurn[];
  /** Sum of entry bytes — maintained by every mutation helper below. */
  bytes: number;
  /** Last write (or creation). Feeds both the TTL sweep and oldest-first eviction. */
  updatedAt: number;
}

/** Keyed by `${mode}:${tenantKey}:${userId}` (memKey) — bare userId leaked
 *  transcripts across tenants (MR !61 review), and a mode-less key leaked them
 *  between demo and real sessions of one user (review !62 round 2); see
 *  ChatIdentity. One continuous dialogue per user AND MODE (D7), mirroring the
 *  chat_sessions_one_active_per_user partial unique index.
 *  PER-PROCESS: with more than one replica, in-memory history is
 *  sticky-session-dependent. docker-compose runs a single backend, so this is
 *  acceptable for v1 — and is a concrete reason to land the DDL. */
let memorySessions = new Map<string, MemorySession>();

/** Serialized bytes across ALL memory sessions — the MAX_TOTAL_BYTES ledger.
 *  Every entry add/drop below adjusts it; nothing else may. */
let memoryTotalBytes = 0;

function memKey(ident: ChatIdentity): string {
  // The 'demo'/'live' prefix keeps demo and real sessions for the SAME user on
  // separate buffers (review !62 round 2, Critical 1) — see ChatIdentity.demo.
  // Without it, replayBufferedEntries drained demo turns into Postgres.
  return `${ident.demo ? 'demo' : 'live'}:${ident.tenantKey}:${ident.userId}`;
}

/** Probe result per tenant. The spec asked for Map<sha256(userDbUrl), …>, but this
 *  module is handed a Pool, not a URL — and DatabaseService.getClientSettingsPool
 *  returns ONE cached Pool instance per tenant and already keys per-tenant state
 *  off the pool object itself (settingsPoolKeys, database.ts:75). Keying on pool
 *  identity gives the same per-tenant granularity with NO URL — and therefore no
 *  password — anywhere in this module (B4-R5), and a recreated pool (password
 *  rotation) starts with a fresh probe, which is correct. */
/** What of the chat schema this tenant actually has. `tables` gates persistence
 *  at all; `clientTurnId` gates the round-6 idempotency column, which a tenant on
 *  an earlier 002 lacks — the store then persists WITHOUT it rather than
 *  downgrading to in-memory (review !62 round 6). */
interface ChatSchema {
  tables: boolean;
  clientTurnId: boolean;
}

let probeCache = new WeakMap<Pool, { schema: ChatSchema; checkedAt: number }>();

/** Test-only: clears the in-memory sessions and the probe cache so suites are
 *  order-independent. Production never calls it. */
export function __resetChatStoreForTests(): void {
  memorySessions = new Map();
  memoryTotalBytes = 0;
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

/** Probe BOTH tables — a half-applied migration must degrade, not half-work — AND
 *  the optional round-6 client_turn_id column. Never throws: an unreachable
 *  settings DB is not "tables missing", so that failure degrades THIS request
 *  without being cached, and persistence resumes the moment the DB does (house
 *  precedent: getGlobalVariables degrades per request and caches success only). */
async function probeChatSchema(pool: Pool): Promise<ChatSchema> {
  const now = Date.now();
  const cached = probeCache.get(pool);
  if (cached && now - cached.checkedAt < PROBE_TTL_MS) return cached.schema;

  try {
    const schema = await withTransientRetry('chatStore.probe', async () => {
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
          return { tables: false, clientTurnId: false };
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
          return { tables: false, clientTurnId: false };
        }

        // The idempotency column is OPTIONAL (review !62 round 6): a tenant on an
        // earlier 002 has the tables but not this column. Persist WITHOUT it
        // rather than let every write throw "column does not exist" — which the
        // caller's try/catch would silently downgrade to in-memory, losing this
        // tenant's persisted history.
        const columnExists = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.columns
            WHERE table_schema = 'dashboard_studio_meta_data'
            AND table_name = 'chat_messages'
            AND column_name = 'client_turn_id'
          )
        `);
        return { tables: true, clientTurnId: Boolean(columnExists.rows[0].exists) };
      } finally {
        client.release();
      }
    });
    probeCache.set(pool, { schema, checkedAt: now });
    return schema;
  } catch (error) {
    logger.warn('chat schema probe failed; degrading to in-memory history', {
      error: toErrorMeta(error).message,
    });
    return { tables: false, clientTurnId: false };
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

function entryBytes(entry: StoredTurn): number {
  if (entry.bytes === undefined) {
    entry.bytes = Buffer.byteLength(JSON.stringify(entry.turn));
  }
  return entry.bytes;
}

function dropSession(key: string): void {
  const session = memorySessions.get(key);
  if (!session) return;
  memoryTotalBytes -= session.bytes;
  memorySessions.delete(key);
}

/** Drop the session's oldest entry WHOLE — payloads are never truncated to fit. */
function dropOldestEntry(session: MemorySession): void {
  const dropped = session.entries.shift();
  if (!dropped) return;
  const bytes = dropped.bytes ?? 0;
  session.bytes -= bytes;
  memoryTotalBytes -= bytes;
}

function sweepExpired(now: number): void {
  for (const [key, session] of memorySessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) dropSession(key);
  }
}

function evictOldestSession(): boolean {
  let oldestKey: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of memorySessions) {
    if (session.updatedAt < oldestAt) {
      oldestAt = session.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey === null) return false;
  dropSession(oldestKey);
  return true;
}

function evictIfOverflow(): void {
  while (memorySessions.size > MAX_SESSIONS) {
    if (!evictOldestSession()) break;
  }
  // The global byte budget (MR !61 review). `size > 1` keeps the newest session
  // even in the degenerate case — per-session enforcement already bounds it.
  while (memoryTotalBytes > MAX_TOTAL_BYTES && memorySessions.size > 1) {
    if (!evictOldestSession()) break;
  }
}

function memoryResolveOrCreate(ident: ChatIdentity): MemorySession {
  // CONCURRENCY GUARD: the Postgres path makes first-turn get-or-create race-safe via
  // the chat_sessions_one_active_per_user partial unique index + ON CONFLICT DO
  // NOTHING. This map has no such constraint, so the guarantee here is that the
  // lookup and the insert run in ONE synchronous tick — there is no await between the
  // .get and the .set — and two concurrent turn-1 requests therefore cannot both miss
  // and mint two sessions. Reachable in practice only if the composer's
  // disabled-while-pending rule is bypassed, but it costs three lines.
  const now = Date.now();
  sweepExpired(now); // TTL is swept lazily on write (and a create IS a write)
  const existing = memorySessions.get(memKey(ident));
  if (existing) return existing;

  const created: MemorySession = {
    sessionId: randomUUID(), entries: [], bytes: 0, updatedAt: now,
  };
  memorySessions.set(memKey(ident), created);
  evictIfOverflow();
  return created;
}

/** The supplied session_id is deliberately not consulted here: one dialogue per user
 *  (D7) means the user's own live session IS the resolution for any id — unknown,
 *  expired or foreign ids silently land on it (D13). Never throws. */
function memoryLoad(ident: ChatIdentity): ChatStoreResult {
  const session = memoryResolveOrCreate(ident);
  return {
    sessionId: session.sessionId,
    history: session.entries.map((e) => e.turn),
    persisted: false,
  };
}

function memoryAppend(ident: ChatIdentity, sessionId: string, entries: StoredTurn[]): void {
  const now = Date.now();
  sweepExpired(now);
  let session = memorySessions.get(memKey(ident));
  if (!session) {
    // A degraded Postgres append (e.g. read-only standby) lands here carrying a
    // Postgres-minted sessionId. Adopt it: if the outage persists, the next
    // loadHistory degrades too, resolves this session and the transcript survives.
    session = { sessionId, entries: [], bytes: 0, updatedAt: now };
    memorySessions.set(memKey(ident), session);
  } else if (session.sessionId !== sessionId) {
    // The id from THIS request's loadHistory is authoritative (D13). Same user,
    // same single dialogue (D7) — keep the turns, adopt the newer id.
    session.sessionId = sessionId;
  }
  // Keep entry timestamps strictly increasing within the buffer: replay order IS
  // created_at order, so a clock step backwards between two buffered writes must
  // not be able to flip a user/assistant pair.
  let lastAt = session.entries[session.entries.length - 1]?.at ?? 0;
  for (const entry of entries) {
    if (entry.at <= lastAt) entry.at = lastAt + 1;
    lastAt = entry.at;
    const bytes = entryBytes(entry);
    session.bytes += bytes;
    memoryTotalBytes += bytes;
  }
  session.entries.push(...entries);
  // Per-session budgets, oldest-first and WHOLE turns only. `length > 1` keeps the
  // just-appended turn even if it alone exceeds the budget (it cannot today: a
  // result is capped at the 5 MiB artifact plus 4000 chars of prose).
  while (session.bytes > MAX_SESSION_BYTES && session.entries.length > 1) {
    dropOldestEntry(session);
  }
  while (session.entries.length > MAX_TURNS) {
    dropOldestEntry(session);
  }
  session.updatedAt = now;
  evictIfOverflow(); // the create above and the bytes just added, in one place
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
  id: string;
  role: string;
  type: string | null;
  content: string;
  result: unknown;
  /** Present only when the tenant's schema has the round-6 column AND the read
   *  path selected it; absent/null on assistant turns, legacy rows and older
   *  schemas. */
  client_turn_id?: string | null;
}

/** SERIALIZE every writer on ONE session before it INSERTs and prunes (MR !61
 *  round 6, note 56627). The round-5 prune is a read-modify-write — it computes a
 *  DELETE boundary from a COUNT and then deletes — so under READ COMMITTED two
 *  concurrent append/replay transactions each take their pre-INSERT snapshot
 *  before the other's turn is visible, both compute the SAME boundary (the
 *  MAX_TURNS-th newest seq) and delete the SAME single row while inserting two.
 *  The second's DELETE blocks on the first's row lock, then re-checks its qual
 *  against the now-deleted tuple WITHOUT re-running the boundary subquery — so it
 *  removes nothing (rowCount 0) and the table settles at MAX_TURNS+1. The
 *  reviewer reproduced exactly this on PostgreSQL 16 (start 100, two parallel
 *  BEGIN/INSERT/prune, deleteA=1 deleteB=0 count=101); so did I, and this lock
 *  closes it (count=100). Multiple browser tabs, or GET /session's replay racing
 *  POST /chat's append, make it reachable.
 *
 *  A row lock on the ONE chat_sessions row (NOT the trailing session-touch
 *  UPDATE, which lands after the prune) makes the second writer block at the TOP
 *  of its transaction; its later per-statement snapshots then see the first's
 *  committed INSERT, so its boundary is recomputed against the true count and the
 *  bound stays strict. Applied on BOTH write paths. The row is guaranteed to
 *  exist and be committed here: resolveSession created it before any append, and
 *  the chat_messages -> chat_sessions foreign key could not otherwise be
 *  satisfied. Deadlock-free: a user's writers all contend for their single
 *  session row and each transaction locks only that one row — no lock-ordering
 *  cycle. */
async function lockSession(
  client: PoolClient, userId: string, sessionId: string,
): Promise<void> {
  await client.query(
    `SELECT 1 FROM dashboard_studio_meta_data.chat_sessions
      WHERE id = $1 AND user_id = $2
      FOR UPDATE`,
    [sessionId, userId],
  );
}

/** The ONE way a turn reaches chat_messages — direct append and buffered replay
 *  share it, so both carry the store-minted id (idempotence) and the entry-time
 *  created_at (order). Runs inside the caller's open transaction. */
async function insertEntry(
  client: PoolClient, userId: string, sessionId: string, entry: StoredTurn,
  hasClientTurnId: boolean,
): Promise<void> {
  const { turn } = entry;
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
  // client_turn_id rides on user turns only (review !62 round 6). The column
  // exists only where the tenant applied the round-6 002 — probeChatSchema tells
  // us — so branch the INSERT: on an older schema, write the legacy shape and let
  // the turn carry no id in Postgres rather than fail the write.
  const clientTurnId = turn.role === 'user' ? turn.client_turn_id ?? null : null;
  if (hasClientTurnId) {
    await client.query(
      `INSERT INTO dashboard_studio_meta_data.chat_messages
         (id, session_id, user_id, role, content, type, result, client_turn_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [entry.id, sessionId, userId, turn.role, turn.content, type, result, clientTurnId, entry.at],
    );
    return;
  }
  await client.query(
    `INSERT INTO dashboard_studio_meta_data.chat_messages
       (id, session_id, user_id, role, content, type, result, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
     ON CONFLICT (id) DO NOTHING`,
    [entry.id, sessionId, userId, turn.role, turn.content, type, result, entry.at],
  );
}

/** RETENTION (MR !61 round 5, note 56601): chat_messages grew without bound —
 *  every turn INSERTed unconditionally while MAX_TURNS bounded only the SELECT
 *  and the memory path, so 101 exchanges left 202 rows (full result payloads
 *  included) in the tenant's settings DB with the API able to return just the
 *  newest 100, and growth never stopped. Runs inside the SAME transaction as the
 *  inserts — both write paths (append and replay) call it after their INSERTs —
 *  so the bound lands atomically with the growth. Retention IS visibility:
 *  `seq <= (the MAX_TURNS-th newest seq)` deletes exactly the rows the read
 *  path (ORDER BY seq DESC LIMIT MAX_TURNS) can never return again, and the
 *  subquery-plus-DELETE both walk chat_messages_session_seq_idx. When the
 *  session holds ≤ MAX_TURNS rows the subquery is empty and `seq <= NULL`
 *  matches nothing — a no-op. */
async function pruneOldTurns(
  client: PoolClient, userId: string, sessionId: string,
): Promise<void> {
  // Correct only because lockSession (called first in both write transactions)
  // has serialized this session's writers — otherwise concurrent transactions
  // compute this boundary from stale snapshots and the bound leaks (round 6).
  const pruned = await client.query(
    `DELETE FROM dashboard_studio_meta_data.chat_messages
      WHERE session_id = $1 AND user_id = $2
        AND seq <= (SELECT seq FROM dashboard_studio_meta_data.chat_messages
                     WHERE session_id = $1 AND user_id = $2
                     ORDER BY seq DESC
                     OFFSET $3 LIMIT 1)`,
    [sessionId, userId, MAX_TURNS],
  );
  if ((pruned.rowCount ?? 0) > 0) {
    logger.info('Pruned chat turns beyond the retention bound', {
      sessionId,
      pruned: pruned.rowCount,
      keep: MAX_TURNS,
    });
  }
}

/** RECONCILIATION (MR !61 review): INSERT every buffered entry for this identity
 *  into the given Postgres session, inside the caller's OPEN transaction. Returns
 *  the replayed ids; the caller clears them from the buffer with clearReplayed
 *  AFTER its COMMIT — clearing earlier would lose them on rollback. The buffer may
 *  target a different (memory-minted) sessionId than the resolved one; D7's single
 *  dialogue per user makes the resolved session the right destination either way. */
async function replayBufferedEntries(
  client: PoolClient, ident: ChatIdentity, sessionId: string, hasClientTurnId: boolean,
): Promise<string[]> {
  const session = memorySessions.get(memKey(ident));
  if (!session || session.entries.length === 0) return [];
  const snapshot = [...session.entries];
  for (const entry of snapshot) {
    await insertEntry(client, ident.userId, sessionId, entry, hasClientTurnId);
  }
  logger.info('Replayed buffered chat turns into Postgres', {
    sessionId,
    replayed: snapshot.length,
  });
  return snapshot.map((e) => e.id);
}

/** Drop successfully replayed entries from the buffer — by id, not wholesale: a
 *  concurrent request (GET /session racing POST /chat) may have buffered NEW
 *  entries between the replay snapshot and the COMMIT, and those must survive for
 *  the next replay. */
function clearReplayed(ident: ChatIdentity, replayedIds: string[]): void {
  if (replayedIds.length === 0) return;
  const session = memorySessions.get(memKey(ident));
  if (!session) return;
  const replayed = new Set(replayedIds);
  let freed = 0;
  session.entries = session.entries.filter((e) => {
    if (!replayed.has(e.id)) return true;
    freed += e.bytes ?? 0;
    return false;
  });
  session.bytes -= freed;
  memoryTotalBytes -= freed;
  if (session.entries.length === 0) dropSession(memKey(ident));
}

/** Maps a chat_messages row onto the AgentTurn union (§3.1). Legacy rows (type NULL)
 *  and — defensively — a 'result' row whose payload is missing render as plain
 *  assistant prose, i.e. the 'question' arm with `type` absent. */
function rowToTurn(row: ChatMessageRow): AgentTurn {
  if (row.role === 'user') {
    // Carry client_turn_id when the row has one (round-6 schema). exactOptional
    // types forbid an explicit `undefined`, so branch rather than spread a null.
    return row.client_turn_id
      ? { role: 'user', content: row.content, client_turn_id: row.client_turn_id }
      : { role: 'user', content: row.content };
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
  pool: Pool, ident: ChatIdentity, sessionId: string | null, hasClientTurnId: boolean,
): Promise<ChatStoreResult> {
  const { userId } = ident;
  // Wrapped in the transient retry like getGlobalVariables' whole read path
  // (database.ts:660): everything inside is idempotent — session get-or-create is
  // ON CONFLICT DO NOTHING, and replayed turns carry store-minted ids under
  // ON CONFLICT (id) DO NOTHING, so a retried replay cannot duplicate.
  return withTransientRetry('chatStore.loadHistory', async () => {
    const client = await pool.connect();
    try {
      const resolved = await resolveSession(client, userId, sessionId);

      // RECONCILIATION, read side (MR !61 review): drain the outage buffer BEFORE
      // reading, so a transcript split across stores heals on the next healthy
      // touch — including the whole memory-era transcript the moment the probe
      // notices the tables were applied.
      let unreplayed: StoredTurn[] = [];
      const buffered = memorySessions.get(memKey(ident));
      if (buffered && buffered.entries.length > 0) {
        try {
          await client.query('BEGIN');
          // Serialize this session's writers before draining + pruning, so a
          // replay racing a concurrent append cannot compute the prune boundary
          // from a stale count and overfill the table (round 6, note 56627).
          await lockSession(client, userId, resolved);
          const replayedIds = await replayBufferedEntries(client, ident, resolved, hasClientTurnId);
          // A drained outage buffer can push the session past MAX_TURNS just
          // like an append can — prune in the same transaction (round 5).
          await pruneOldTurns(client, userId, resolved);
          await client.query('COMMIT');
          clearReplayed(ident, replayedIds);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          // A failed replay must not fail the READ: keep the buffer for the next
          // touch and MERGE it into the response below, so the user still sees
          // their result while it waits to reach Postgres.
          unreplayed = [...buffered.entries];
          logger.warn('chat buffer replay failed; serving merged history, keeping the buffer', {
            error: toErrorMeta(error).message,
          });
        }
      }

      // Cap the COUNT of turns on read — a long transcript cannot blow the response
      // size. Result turns keep their full `result` payload: stripping dashboards
      // would be the failure D16 exists to prevent (an assistant claiming it built a
      // dashboard with no way to preview it). Newest MAX_TURNS, returned oldest-first.
      //
      // ORDER BY seq, NOT created_at: replay drains the buffer before any new
      // append, so insertion order IS conversation order — while timestamps can tie
      // within a millisecond (a replayed turn plus a fresh one) or step backwards
      // with the clock, and either would let a user/assistant pair flip on read.
      // Select client_turn_id only where the column exists (probeChatSchema).
      // Both column lists are fixed literals — no user input is interpolated.
      const columns = hasClientTurnId
        ? 'id, role, type, content, result, client_turn_id'
        : 'id, role, type, content, result';
      const rows = await client.query(
        `SELECT ${columns}
           FROM dashboard_studio_meta_data.chat_messages
          WHERE session_id = $1 AND user_id = $2
          ORDER BY seq DESC
          LIMIT $3`,
        [resolved, userId, MAX_TURNS],
      );
      const pgRows = rows.rows as ChatMessageRow[];
      let history = pgRows.slice().reverse().map(rowToTurn);
      if (unreplayed.length > 0) {
        // Buffer ∩ Postgres is empty by construction, with ONE exception: an
        // in-doubt COMMIT (applied server-side, error client-side) leaves the turn
        // in both until the next replay clears it — so merge by id, not blindly.
        const present = new Set(pgRows.map((r) => String(r.id)));
        const missing = unreplayed.filter((e) => !present.has(e.id)).map((e) => e.turn);
        history = [...history, ...missing].slice(-MAX_TURNS);
      }
      return { sessionId: resolved, history, persisted: true };
    } finally {
      client.release();
    }
  });
}

async function pgAppendTurns(
  pool: Pool, ident: ChatIdentity, sessionId: string, entries: StoredTurn[],
  hasClientTurnId: boolean,
): Promise<void> {
  const { userId } = ident;
  // A WRITE — deliberately NOT wrapped in withTransientRetry: the failure path
  // (buffer, then replay on the next healthy touch) already delivers the turn
  // exactly once, which an inline retry could only approximate.
  //
  // ONE transaction covers the buffered replay, the new turns and the session
  // touch (MR !61 review): it lands whole or not at all, so memory and Postgres
  // can never hold overlapping halves of a request.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize this session's writers before any INSERT + prune (round 6, note
    // 56627): two concurrent appends must not each prune against a snapshot taken
    // before the other's turn is visible, or the retention bound leaks by one.
    await lockSession(client, userId, sessionId);
    // RECONCILIATION, write side: drain older buffered turns FIRST so a healed
    // transcript keeps its order — the user turn from a moment ago may sit in the
    // buffer while this assistant turn finds Postgres healthy again.
    const replayedIds = await replayBufferedEntries(client, ident, sessionId, hasClientTurnId);
    for (const entry of entries) {
      await insertEntry(client, userId, sessionId, entry, hasClientTurnId);
    }
    // Retention bound, atomic with the inserts above (round 5, note 56601).
    await pruneOldTurns(client, userId, sessionId);
    await client.query(
      `UPDATE dashboard_studio_meta_data.chat_sessions
          SET updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    await client.query('COMMIT');
    clearReplayed(ident, replayedIds);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
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
  pool: Pool | null, ident: ChatIdentity, sessionId: string | null,
): Promise<ChatStoreResult> {
  // A demo identity NEVER reaches Postgres, even when handed a live pool
  // (review !62 round 2, Critical 1). Enforced HERE, in the store, so no route
  // wiring mistake can read the tenant's persisted transcript into a demo
  // session — or replay a demo buffer out of memory into their database.
  if (pool && !ident.demo) {
    try {
      const schema = await probeChatSchema(pool);
      if (schema.tables) {
        return await pgLoadHistory(pool, ident, sessionId, schema.clientTurnId);
      }
    } catch (error) {
      logger.warn('chatStore.loadHistory degraded to in-memory history', {
        error: toErrorMeta(error).message,
      });
    }
  }
  return memoryLoad(ident);
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
 * INSERT) degrades to the in-memory path — which since MR !61's review is a
 * WRITE-BEHIND BUFFER, not a dead end: the next healthy Postgres touch (load or
 * append) transactionally replays buffered turns into the resolved session, so a
 * partial failure can never orphan an assistant result, and the turn itself
 * already reached the user in the HTTP response.
 */
export async function appendTurns(
  pool: Pool | null, ident: ChatIdentity, sessionId: string, turns: AgentTurn[],
): Promise<void> {
  // Entry ids and timestamps are minted HERE, before any storage decision, so the
  // same identity follows a turn wherever it lands — memory today, Postgres on
  // replay tomorrow — and ON CONFLICT (id) DO NOTHING makes double-insertion
  // structurally impossible.
  let at = Date.now();
  const entries: StoredTurn[] = turns.map((turn) => ({ id: randomUUID(), at: at++, turn }));
  // Same demo override as loadHistory (review !62 round 2, Critical 1): a demo
  // turn must be structurally unable to reach chat_messages.
  if (pool && !ident.demo) {
    try {
      const schema = await probeChatSchema(pool);
      if (schema.tables) {
        await pgAppendTurns(pool, ident, sessionId, entries, schema.clientTurnId);
        return;
      }
    } catch (error) {
      logger.warn('chatStore.appendTurns degraded to in-memory history', {
        error: toErrorMeta(error).message,
      });
    }
  }
  memoryAppend(ident, sessionId, entries);
}

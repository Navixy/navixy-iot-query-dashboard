/**
 * Chat transcript store for the AI dashboard agent (DO-313).
 *
 * Three properties define this file:
 *
 * 1. IT NEVER THROWS AND NEVER 500s. Missing tables, revoked grants, a settings DB
 *    briefly routed to a read-only standby — every failure is caught and
 *    logger.warn'ed once.
 *
 *    For READS and for UNGUARDED appends (the assistant result) that means degrading
 *    to the bounded in-memory path, which is a WRITE-BEHIND BUFFER (MR !61 review):
 *    the next healthy Postgres touch replays it into the resolved session, so a
 *    tenant whose DBA has not applied 002_add_chat_tables.sql still gets a working
 *    chat, and the transcript CAN reach Postgres once the DDL lands.
 *
 *    "Can", not "will" (!65 round 12 — this used to say a mid-dialogue outage "no
 *    longer forfeits the turns it swallowed"). The buffer is process-local and
 *    bounded, and replay needs a LATER request on the SAME process: an eviction, a
 *    restart or a session nobody returns to ends it, and nothing replays on a timer.
 *    Best-effort recovery of the transcript, never a delivery guarantee — the outcome
 *    table in docs/ai-agent-seam.md §7 states the same bounds.
 *
 *    A GUARDED append (rejectWhenTurnActive — the user turn) does NOT always degrade,
 *    and saying "every failure degrades" here was wrong (!65 round 11). It FAILS
 *    CLOSED with 'unavailable', buffering nothing, from BOTH of its origins: an
 *    unresolved capability probe, and a write failure on a tenant known to have
 *    receipts. Not throwing is not the same as not refusing. See AppendOutcome.
 *
 *    DEMO identities are a further exception (review !62 round 2): they live in their
 *    own memory namespace, never reach Postgres and never join the replay — see
 *    ChatIdentity.demo.
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
  /** Whether this result's turns round-trip client_turn_id (review !62 round 7,
   *  finding 5a). True for the in-memory path and for Postgres WITH the round-6
   *  column; false only on an older 002 whose column is absent. Surfaced so the
   *  client trusts id reconciliation from an explicit capability, not inference. */
  supportsTurnIds: boolean;
  /**
   * Does this session have a turn still awaiting its reply, JUDGED BY THE SAME TTL
   * THE GUARD USES? (review !62 round 12, Important 4.)
   *
   * The client derived this itself, from an unmatched user row in the transcript
   * with no notion of age — so once a turn was abandoned between its user append
   * and its assistant append (a crashed process, a timed-out agent call), the
   * composer locked FOREVER. The backend stopped counting that turn as active
   * after ~200 s, but nothing said so: polling gave up after 48 attempts and a
   * reload re-read the same row. Two definitions of "awaiting" is one too many;
   * this is the authoritative one, and the client uses it.
   *
   * UNDEFINED MEANS "COULD NOT BE DETERMINED" (review !62 round 13, Important 1),
   * and is NOT the same claim as `false`. Round 12 returned a plain boolean, so
   * every path that had no way to answer — a tenant with no usable receipts table
   * (including 003-without-004, which we deliberately treat as no receipts), or a
   * failed read that degraded to an empty memory buffer — answered `false`. The
   * client trusts any boolean absolutely, so that unlocked the composer and the
   * pre-send guard on exactly the tenants whose SERVER-side guard is also off: on
   * an old schema a second stateful turn was then genuinely accepted.
   *
   * Callers must propagate the distinction rather than defaulting it: the route
   * OMITS the wire field when this is undefined, which is what puts the client
   * back on its transcript-derived fallback.
   */
  awaitingReply?: boolean;
}

/**
 * Whether an append landed, or was refused (review !62 round 10, Important 3/4;
 * extended round 11, Important 2).
 *
 * - 'appended'    — written.
 * - 'busy'        — this session already has a turn awaiting its reply.
 * - 'duplicate'   — a receipt for this client_turn_id already exists. The turn is
 *                   a repeat, not a new one: admitting it would both double-feed
 *                   the stateful agent and leave the guard blind, since the
 *                   receipt insert's ON CONFLICT DO NOTHING means no NEW 'received'
 *                   row would ever appear for it.
 * - 'unavailable' — GUARDED appends only, and it has TWO origins (!65 round 11
 *                   found this entry describing just the second):
 *                     (a) the capability probe did not resolve, so we cannot tell
 *                         whether this tenant's guard is authoritative. NOTHING was
 *                         written — no INSERT was attempted.
 *                     (b) the tenant is known to support receipts and the Postgres
 *                         write FAILED. Whether it ran is unknown: an in-doubt
 *                         COMMIT may have persisted the turn and its 'received'
 *                         receipt, and nothing will ever replay it (see §7 of
 *                         docs/ai-agent-seam.md — the orphaned turn, DO-383).
 *                   Either way FAIL CLOSED and buffer NOTHING: degrading to the
 *                   memory buffer would admit a turn that bypassed the lock, since
 *                   memory cannot see a receipt another replica may hold.
 */
export type AppendOutcome = 'appended' | 'busy' | 'duplicate' | 'unavailable';

/** Options for appendTurns. */
export interface AppendOptions {
  /**
   * SINGLE ACTIVE TURN PER SESSION. Refuse instead of appending when this
   * session already holds a user turn awaiting its reply.
   *
   * Pass it for the USER turn only. The assistant turn is what RELEASES the
   * guard, so blocking it would deadlock the session for a full TTL.
   *
   * The client tries hard not to reach this — the composer locks on
   * server-derived state, and a send validates against an authoritative read —
   * but every one of those guards is per-tab and best-effort: two tabs are not
   * synchronized, and a transient GET failure can leave one of them unable to
   * tell. Bedrock keys its conversation memory server-side on the session id, so
   * a second concurrent turn corrupts the dialogue for BOTH. This is the last
   * line, at the only place that sees every tab.
   */
  rejectWhenTurnActive?: boolean;
  /** How long an unanswered user turn still counts as running. MUST be at least
   *  the route's agent deadline, or a turn could be refused while its
   *  predecessor is legitimately still working. Past it, the turn is treated as
   *  abandoned (crashed process, timed-out agent call) so a dead turn cannot
   *  wedge the session. */
  activeTurnTtlMs?: number;
}

/** Durable per-turn receipt status (review !62 round 7, finding 5b). */
export interface TurnStatusResult {
  status: 'received' | 'answered' | 'unknown';
  /** Whether the tenant has the receipts table at all. */
  supported: boolean;
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
/** How many admitted client_turn_ids a memory session remembers (review !62
 *  round 13, Important 4). Deliberately well past MAX_TURNS: the whole point is
 *  to outlive transcript eviction. 500 ids ≈ 20 KB per session at worst, and the
 *  ids are bounded to 100 chars by the route's validator. */
const MAX_SEEN_TURN_IDS = 500;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

/** Probe cache TTL: short enough that a DBA applying the DDL is not locked out by a
 *  cached "absent" for long, long enough that it is not a per-request round trip.
 *
 *  It bounds STALENESS, not recovery time (!65 round 8 — this comment used to promise
 *  "live within a minute", and the doc inherited the overstatement). Nothing polls and
 *  nothing replays in the background: the tenant heals on the first touch AFTER the
 *  cached absence expires. On an idle tenant that can be arbitrarily later. */
const PROBE_TTL_MS = 60_000;

/** Fallback for AppendOptions.activeTurnTtlMs. The route passes its own value
 *  derived from AGENT_TIMEOUT_MS; this only covers callers that ask for the
 *  guard without naming a window. Comfortably above the 180 s default deadline
 *  so a legitimately-running turn is never mistaken for an abandoned one. */
const DEFAULT_ACTIVE_TURN_TTL_MS = 200_000;

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
  /** For a pooled tenant this doubles as the WRITE-BEHIND BUFFER: a turn lands here
   *  when its Postgres write failed or the tables are missing, so an entry is
   *  USUALLY absent from Postgres — but not always, and replay does not rely on it
   *  (!65 round 10; this said "by construction every entry here is absent", and
   *  called that the invariant). An in-doubt COMMIT — applied server-side, errored
   *  client-side — leaves the SAME turn in Postgres and here, until a replay
   *  reconciles them. **What actually makes blind replay safe is store-minted ids
   *  plus ON CONFLICT (id) DO NOTHING**, which is a property of the write, not of
   *  the buffer's contents. Bounded by MAX_TURNS and MAX_SESSION_BYTES — an
   *  outage longer than those loses oldest turns, the same bound the pure-memory
   *  tenant already lives with. */
  entries: StoredTurn[];
  /** Sum of entry bytes — maintained by every mutation helper below. */
  bytes: number;
  /** Last write (or creation). Feeds both the TTL sweep and oldest-first eviction. */
  updatedAt: number;
  /**
   * Every client_turn_id this session has ADMITTED, retained past the point its
   * turns fall out of `entries` (review !62 round 13, Important 4).
   *
   * The duplicate check used to scan `entries`, which MAX_TURNS caps at 100 — so
   * after ~51 completed exchanges the oldest ids were evicted and replaying one
   * was admitted as a new turn, double-feeding the stateful agent. The durable
   * path has no such hole because its receipts table lives OUTSIDE the transcript
   * window; this is the memory/demo equivalent of that separation.
   *
   * Insertion-ordered, so the oldest key is the first one out. Ids only — never
   * turns — so MAX_SEEN_TURN_IDS entries cost ~40 bytes each and stay off the
   * MAX_SESSION_BYTES ledger, which exists to bound TRANSCRIPT size.
   */
  seenTurnIds: Set<string>;
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
  /** Whether the durable per-turn receipts table exists AND carries the per-user
   *  key 004 introduces (review !62 round 7 finding 5b; round 12 Important 3) —
   *  gates the receipt upsert, the turn-status lookup and the turn guard. */
  receipts: boolean;
  /**
   * Did we actually LEARN this tenant's capabilities, or is it a placeholder for
   * "the probe failed"? (review !62 round 12, Important 2.)
   *
   * The probe returned all-false on any error, which is indistinguishable from
   * "proved absent" — so a settings DB blip made a receipts-capable tenant look
   * like one with no receipts at all, and the guarded append quietly degraded to
   * process memory where an already-active Postgres receipt is invisible. On two
   * replicas each could then admit its own turn. A guarded user append refuses
   * outright when capability is unknown; everything else keeps degrading.
   */
  known: boolean;
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
          return { tables: false, clientTurnId: false, receipts: false, known: true };
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
          return { tables: false, clientTurnId: false, receipts: false, known: true };
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
        // The receipts table is also OPTIONAL (review !62 round 7, 003 migration):
        // absent on a tenant who has not applied 003. Its absence only disables
        // the durable turn-status lookup; it never blocks chat or persistence.
        //
        // USABLE ONLY WITH THE PER-USER KEY (review !62 round 12, Important 3).
        // 003 keyed the table globally on client_turn_id while every check that
        // reads it is scoped by user_id, and the id is a client-minted arbitrary
        // string: user B sending a turn under an id user A already holds got no
        // receipt of their own (global conflict) and B's reply then flipped A's
        // receipt to 'answered', releasing A's guard mid-turn. 004 fixes the key.
        // Until a tenant applies it, the receipts table is treated as ABSENT —
        // no lock and no turn-status rather than a cross-user hazard.
        const receiptsPk = await client.query(`
          SELECT k.column_name
            FROM information_schema.table_constraints c
            JOIN information_schema.key_column_usage k
              ON k.constraint_name = c.constraint_name
             AND k.constraint_schema = c.constraint_schema
           WHERE c.constraint_schema = 'dashboard_studio_meta_data'
             AND c.table_name = 'chat_turn_receipts'
             AND c.constraint_type = 'PRIMARY KEY'
        `);
        const pkColumns = receiptsPk.rows.map((r: { column_name: string }) => r.column_name).sort();
        const receipts =
          pkColumns.length === 2 &&
          pkColumns[0] === 'client_turn_id' &&
          pkColumns[1] === 'user_id';
        if (!receipts && pkColumns.length > 0) {
          logger.warn('chat_turn_receipts is keyed globally; apply 004 to enable the turn guard', {
            pkColumns,
          });
        }
        return {
          tables: true,
          clientTurnId: Boolean(columnExists.rows[0].exists),
          receipts,
          known: true,
        };
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
    // LAST-KNOWN CAPABILITY beats a guess (review !62 round 12, Important 2). The
    // cache above is consulted only while fresh, so an expired entry was being
    // thrown away — even though a tenant's schema does not change because their
    // database went briefly unreachable. Reusing it keeps a receipts-capable
    // tenant recognised as such, which is what makes the guarded append fail
    // CLOSED rather than silently degrade past its own lock.
    if (cached) return cached.schema;
    // Never probed successfully: we genuinely do not know. `known: false` is what
    // the guarded append refuses on.
    return { tables: false, clientTurnId: false, receipts: false, known: false };
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
    seenTurnIds: new Set(),
  };
  memorySessions.set(memKey(ident), created);
  evictIfOverflow();
  return created;
}

/** The supplied session_id is deliberately not consulted here: one dialogue per user
 *  (D7) means the user's own live session IS the resolution for any id — unknown,
 *  expired or foreign ids silently land on it (D13). Never throws. */
function memoryLoad(
  ident: ChatIdentity, activeTurnTtlMs?: number, opts?: { authoritative?: boolean },
): ChatStoreResult {
  const session = memoryResolveOrCreate(ident);
  return {
    sessionId: session.sessionId,
    history: session.entries.map((e) => e.turn),
    persisted: false,
    // Same predicate and same TTL the guard applies on append (round 12).
    //
    // Authoritative only when this buffer IS the store — a demo identity, a null
    // pool, or a tenant without the chat tables. When we land here because a
    // Postgres read FAILED (review !62 round 13, Important 1), the real turns are
    // in a database we could not read and this buffer is empty; answering "false"
    // from it would unlock the composer on the strength of no evidence at all.
    ...(opts?.authoritative === false
      ? {}
      : {
        awaitingReply: memoryHasActiveTurn(
          session, Date.now(), activeTurnTtlMs ?? DEFAULT_ACTIVE_TURN_TTL_MS,
        ),
      }),
    // The in-memory store carries client_turn_id on the turn objects it holds, so
    // ids round-trip here too (review !62 round 7, finding 5a).
    supportsTurnIds: true,
  };
}

/**
 * Does this in-memory session already hold a user turn that is still awaiting its
 * reply, recently enough to still be running? (review !62 round 10, Important 3/4
 * — the memory half of the single-active-turn guard.)
 *
 * Same predicate the client derives from GET /session: a user turn whose
 * client_turn_id has no matching assistant reply. Pairing by id rather than
 * "newest turn is a user turn" is what catches an interleaved
 * [user A, user B, assistant B] where A is still running. Turns without an id
 * (older clients) fall back to the newest-turn test, which is all their data
 * supports.
 *
 * The TTL is what stops an ABANDONED turn — the process died between persisting
 * the user turn and the reply, or the agent call timed out — from wedging the
 * session forever. It must be at least the route's own deadline, or a turn could
 * be refused while its predecessor is legitimately still running.
 */
function memoryHasActiveTurn(session: MemorySession, now: number, ttlMs: number): boolean {
  const answered = new Set<string>();
  for (const entry of session.entries) {
    const id = entry.turn.role === 'assistant' ? entry.turn.client_turn_id : undefined;
    if (id) answered.add(id);
  }
  for (let i = session.entries.length - 1; i >= 0; i--) {
    const entry = session.entries[i];
    if (!entry) continue;
    // Entries are ordered by `at`, so the first one outside the window ends the scan.
    if (entry.at <= now - ttlMs) return false;
    if (entry.turn.role !== 'user') continue;
    const id = entry.turn.client_turn_id;
    if (!id) {
      // No id to pair on: only a trailing user turn tells us anything.
      if (i === session.entries.length - 1) return true;
      continue;
    }
    if (!answered.has(id)) return true;
  }
  return false;
}

function memoryAppend(
  ident: ChatIdentity, sessionId: string, entries: StoredTurn[], options?: AppendOptions,
): AppendOutcome {
  const now = Date.now();
  sweepExpired(now);
  let session = memorySessions.get(memKey(ident));
  if (session && options?.rejectWhenTurnActive) {
    if (memoryHasActiveTurn(session, now, options.activeTurnTtlMs ?? DEFAULT_ACTIVE_TURN_TTL_MS)) {
      return 'busy';
    }
    // A REPLAYED id is refused here too (review !62 round 12, Important 2). Round
    // 11 added this check only to the Postgres path, so on the memory/demo path a
    // repeat of an already-answered id was admitted — and its OLD assistant turn
    // immediately made the new user turn look answered, blinding the guard again.
    //
    // Checked against the ID REGISTRY, not the transcript (review !62 round 13,
    // Important 4). Scanning `entries` alone meant the check expired with the
    // turns: MAX_TURNS caps the buffer at 100, so after ~51 completed exchanges
    // the oldest ids were evicted and replaying one came back 'appended'. The
    // registry outlives that window, which is what the durable path gets for free
    // by keeping receipts in a separate table. `entries` is still consulted for
    // ids that arrived before this session started tracking them.
    const replayedId = entries.find(
      (e) => e.turn.role === 'user' && e.turn.client_turn_id,
    )?.turn.client_turn_id;
    if (replayedId && (
      session.seenTurnIds.has(replayedId) ||
      session.entries.some((e) => e.turn.client_turn_id === replayedId)
    )) {
      return 'duplicate';
    }
  }
  if (!session) {
    // A degraded Postgres append (e.g. read-only standby) lands here carrying a
    // Postgres-minted sessionId. Adopt it: if the outage persists, the next
    // loadHistory degrades too, resolves this session and the transcript survives.
    session = { sessionId, entries: [], bytes: 0, updatedAt: now, seenTurnIds: new Set() };
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
  // Record every id this append admitted, BEFORE the transcript eviction below can
  // take the turns away (review !62 round 13, Important 4). Done unconditionally,
  // not only under the guard: an UNGUARDED append (the assistant reply, a replayed
  // buffer) still establishes that the id has been seen, and a later guarded
  // replay of it must be refused.
  for (const entry of entries) {
    const id = entry.turn.client_turn_id;
    if (id) rememberTurnId(session, id);
  }
  session.updatedAt = now;
  evictIfOverflow(); // the create above and the bytes just added, in one place
  return 'appended';
}

/** Add an id to the session's bounded seen-id registry, evicting oldest-first.
 *  Insertion-ordered Set: the first key is the oldest, and an id already present
 *  keeps its original position rather than being refreshed — retention is about
 *  age of FIRST sighting, which is what a replay window means. */
function rememberTurnId(session: MemorySession, id: string): void {
  if (session.seenTurnIds.has(id)) return;
  session.seenTurnIds.add(id);
  while (session.seenTurnIds.size > MAX_SEEN_TURN_IDS) {
    const oldest = session.seenTurnIds.values().next().value;
    if (oldest === undefined) break;
    session.seenTurnIds.delete(oldest);
  }
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
  schema: ChatSchema,
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
  // client_turn_id rides on BOTH the user turn and its assistant reply (review
  // !62 round 7, finding 3 — the route stamps the reply with the originating id).
  // The column exists only where the tenant applied the round-6 002/003 —
  // probeChatSchema tells us — so branch the INSERT: on an older schema, write the
  // legacy shape and let the turn carry no id in Postgres rather than fail.
  const clientTurnId = turn.client_turn_id ?? null;
  if (schema.clientTurnId) {
    await client.query(
      `INSERT INTO dashboard_studio_meta_data.chat_messages
         (id, session_id, user_id, role, content, type, result, client_turn_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [entry.id, sessionId, userId, turn.role, turn.content, type, result, clientTurnId, entry.at],
    );
  } else {
    await client.query(
      `INSERT INTO dashboard_studio_meta_data.chat_messages
         (id, session_id, user_id, role, content, type, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [entry.id, sessionId, userId, turn.role, turn.content, type, result, entry.at],
    );
  }

  // Durable per-turn receipt (review !62 round 7, finding 5b), written in the SAME
  // transaction as the message so status and content can never disagree, but kept
  // in a table that is NOT pruned with the transcript. The user turn records
  // 'received'; its assistant/error reply (same originating id) upgrades it to
  // 'answered'. So a delivered turn evicted from the capped transcript is still
  // confirmable via GET /turn-status.
  if (schema.receipts && clientTurnId) {
    if (turn.role === 'user') {
      await client.query(
        `INSERT INTO dashboard_studio_meta_data.chat_turn_receipts
           (client_turn_id, user_id, session_id, status)
         VALUES ($1, $2, $3, 'received')
         ON CONFLICT (user_id, client_turn_id) DO NOTHING`,
        [clientTurnId, userId, sessionId],
      );
    } else {
      await client.query(
        `INSERT INTO dashboard_studio_meta_data.chat_turn_receipts
           (client_turn_id, user_id, session_id, status)
         VALUES ($1, $2, $3, 'answered')
         ON CONFLICT (user_id, client_turn_id) DO UPDATE SET status = 'answered', updated_at = NOW()`,
        [clientTurnId, userId, sessionId],
      );
    }
  }
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

/** Bound the durable receipts table by RECENCY (review !62 round 7, finding 5b).
 *  A receipt only needs to outlive a reconciliation — seconds to minutes after the
 *  send — with wide margin; 7 days is far more than the client ever waits, and an
 *  age DELETE per append (indexed on user_id, updated_at) keeps the tiny table
 *  bounded without a per-session count. Runs in the append transaction. */
async function pruneOldReceipts(
  client: PoolClient, userId: string, schema: ChatSchema,
): Promise<void> {
  if (!schema.receipts) return;
  await client.query(
    `DELETE FROM dashboard_studio_meta_data.chat_turn_receipts
      WHERE user_id = $1 AND updated_at < NOW() - INTERVAL '7 days'`,
    [userId],
  );
}

/** RECONCILIATION (MR !61 review): INSERT every buffered entry for this identity
 *  into the given Postgres session, inside the caller's OPEN transaction. Returns
 *  the replayed ids; the caller clears them from the buffer with clearReplayed
 *  AFTER its COMMIT — clearing earlier would lose them on rollback. The buffer may
 *  target a different (memory-minted) sessionId than the resolved one; D7's single
 *  dialogue per user makes the resolved session the right destination either way. */
async function replayBufferedEntries(
  client: PoolClient, ident: ChatIdentity, sessionId: string, schema: ChatSchema,
): Promise<string[]> {
  const session = memorySessions.get(memKey(ident));
  if (!session || session.entries.length === 0) return [];
  const snapshot = [...session.entries];
  for (const entry of snapshot) {
    await insertEntry(client, ident.userId, sessionId, entry, schema);
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
  // Carry client_turn_id when the row has one (round-6/7 schema) on BOTH user and
  // assistant turns (finding 3). exactOptional types forbid an explicit
  // `undefined`, so spread an empty object when absent rather than set null.
  const id = row.client_turn_id ? { client_turn_id: row.client_turn_id } : {};
  if (row.role === 'user') {
    return { role: 'user', content: row.content, ...id };
  }
  if (row.type === 'result' && row.result && typeof row.result === 'object') {
    return {
      role: 'assistant',
      type: 'result',
      content: row.content,
      result: row.result as AgentChatResult,
      ...id,
    };
  }
  if (row.type === 'question' || row.type === 'error') {
    return { role: 'assistant', type: row.type, content: row.content, result: null, ...id };
  }
  return { role: 'assistant', content: row.content, result: null, ...id };
}

async function pgLoadHistory(
  pool: Pool, ident: ChatIdentity, sessionId: string | null, schema: ChatSchema,
  activeTurnTtlMs?: number,
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
          const replayedIds = await replayBufferedEntries(client, ident, resolved, schema);
          // A drained outage buffer can push the session past MAX_TURNS just
          // like an append can — prune in the same transaction (round 5).
          await pruneOldTurns(client, userId, resolved);
          await pruneOldReceipts(client, userId, schema);
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
      const columns = schema.clientTurnId
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
      // The SERVER's own awaiting verdict, from the receipts table and the SAME
      // TTL the guard applies on append (review !62 round 12, Important 4). The
      // client used to derive this from an unmatched transcript row with no
      // notion of age, so an abandoned turn locked its composer forever.
      //
      // Only a receipts-capable schema can answer at all (review !62 round 13,
      // Important 1). Without one there is no state to read, and `false` would be
      // a claim rather than an answer — so stay silent and let the client keep
      // its transcript guard, which is the only guard such a tenant has.
      let awaitingReply: boolean | undefined;
      if (schema.receipts) {
        try {
          awaitingReply = await pgHasActiveTurn(
            client, userId, resolved, activeTurnTtlMs ?? DEFAULT_ACTIVE_TURN_TTL_MS, schema,
          );
        } catch (error) {
          // The transcript already loaded; only the verdict failed. Report UNKNOWN
          // and return the history anyway — letting this throw would degrade the
          // whole read to the in-memory path, which for a real user is an EMPTY
          // buffer and would answer "nothing is running" with even less basis.
          logger.warn('chatStore.loadHistory could not determine awaitingReply', {
            error: toErrorMeta(error).message,
          });
        }
      }
      return {
        sessionId: resolved, history, persisted: true,
        supportsTurnIds: schema.clientTurnId,
        // Spread, not `awaitingReply,`: under exactOptionalPropertyTypes an
        // explicit `undefined` is not the same as an absent key, and ABSENT is the
        // representation of "unknown" this contract is built on.
        ...(awaitingReply !== undefined && { awaitingReply }),
      };
    } finally {
      client.release();
    }
  });
}

/**
 * Is a user turn for this session still awaiting its reply? (review !62 round 10
 * — the Postgres half of the single-active-turn guard.)
 *
 * The receipts table added in round 7 already IS this state: a row is written
 * 'received' the moment the user turn is persisted and flipped to 'answered'
 * when its reply lands. Reading it needs no new table, no migration, and — being
 * in the tenant's own database — it is correct across replicas, which a
 * per-process map would not be.
 *
 * MUST be called inside the caller's transaction, AFTER lockSession: the check
 * and the insert that follows it have to be atomic against a concurrent POST, or
 * two turns can both observe an idle session and both proceed.
 *
 * Tenants without the receipts table get no guard. That is the same degradation
 * every other piece of this subsystem takes on an older schema — and it is why
 * the client-side guards stay in place rather than being replaced by this one.
 */
async function pgHasActiveTurn(
  client: PoolClient, userId: string, sessionId: string, ttlMs: number, schema: ChatSchema,
): Promise<boolean> {
  if (!schema.receipts) return false;
  const res = await client.query(
    `SELECT 1 FROM dashboard_studio_meta_data.chat_turn_receipts
      WHERE user_id = $1 AND session_id = $2 AND status = 'received'
        AND created_at > NOW() - make_interval(secs => $3)
      LIMIT 1`,
    [userId, sessionId, ttlMs / 1000],
  );
  return res.rows.length > 0;
}

/**
 * Has this client_turn_id been seen before, in ANY state? (review !62 round 11,
 * Important 2.)
 *
 * The active-turn probe above only sees 'received' receipts, so a REPLAYED id
 * whose receipt is already 'answered' slipped past it — and the receipt insert's
 * ON CONFLICT DO NOTHING meant no new 'received' row would appear for it either,
 * leaving the guard blind for that turn AND the next one. A repeat is not a new
 * turn: it is refused outright rather than double-feeding the stateful agent.
 *
 * Runs inside the same transaction and behind the same row lock as the active
 * check, so a concurrent POST cannot slip between them.
 */
async function pgTurnIdSeen(
  client: PoolClient, userId: string, clientTurnId: string, schema: ChatSchema,
): Promise<boolean> {
  if (!schema.receipts) return false;
  const res = await client.query(
    `SELECT 1 FROM dashboard_studio_meta_data.chat_turn_receipts
      WHERE client_turn_id = $1 AND user_id = $2
      LIMIT 1`,
    [clientTurnId, userId],
  );
  return res.rows.length > 0;
}

async function pgAppendTurns(
  pool: Pool, ident: ChatIdentity, sessionId: string, entries: StoredTurn[],
  schema: ChatSchema, options?: AppendOptions,
): Promise<AppendOutcome> {
  const { userId } = ident;
  // A WRITE — deliberately NOT wrapped in withTransientRetry. The reason is the
  // IN-DOUBT COMMIT, and it is the same for guarded and unguarded appends: a
  // failure here may be a transaction that ALREADY APPLIED, so an inline retry
  // re-runs it blind. Entry ids are minted before any storage decision and every
  // insert is ON CONFLICT (id) DO NOTHING, so a later replay cannot duplicate a
  // turn — but that is IDEMPOTENCE, not a delivery guarantee.
  //
  // This used to justify the no-retry by claiming the unguarded failure path
  // (buffer, then replay on the next healthy touch) "delivers the turn exactly
  // once" (!65 round 12). It does not, and nothing here can. The buffer is
  // PROCESS-LOCAL and bounded — MAX_TURNS, MAX_SESSION_BYTES, MAX_TOTAL_BYTES,
  // SESSION_TTL_MS — and replay needs a LATER request touching the same session on
  // the SAME process. A restart, a redeploy, an eviction, or a user who never comes
  // back ends it there. Best-effort, not eventual. A GUARDED failure does not even
  // buffer: it returns 'unavailable' (see AppendOutcome).
  //
  // ONE transaction covers the buffered replay, the new turns and the session
  // touch (MR !61 review): it lands whole or not at all, so memory and Postgres
  // can never hold overlapping HALVES of a request.
  //
  // That is atomicity, not exclusivity (!65 round 10 — this used to claim the two
  // stores can never overlap at all). An in-doubt COMMIT applies the whole
  // transaction and still reports failure, after which the caller buffers the
  // whole thing too: both stores, one complete copy each, until replay clears it.
  // Never a torn half, which is what this guarantee is for.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize this session's writers before any INSERT + prune (round 6, note
    // 56627): two concurrent appends must not each prune against a snapshot taken
    // before the other's turn is visible, or the retention bound leaks by one.
    await lockSession(client, userId, sessionId);
    // SINGLE ACTIVE TURN (review !62 round 10): inside the transaction and behind
    // the row lock, so the check and this request's INSERT are atomic against a
    // concurrent POST — otherwise two turns can both see an idle session.
    if (options?.rejectWhenTurnActive) {
      if (await pgHasActiveTurn(
        client, userId, sessionId, options.activeTurnTtlMs ?? DEFAULT_ACTIVE_TURN_TTL_MS, schema,
      )) {
        await client.query('ROLLBACK');
        return 'busy';
      }
      // A REPLAYED id is not a new turn (round 11, Important 2). Checked here
      // because the active probe above only sees 'received' receipts, and the
      // receipt insert's ON CONFLICT DO NOTHING would never create one for an id
      // that already exists — so an answered id used to pass both.
      const replayedId = entries.find(
        (e) => e.turn.role === 'user' && e.turn.client_turn_id,
      )?.turn.client_turn_id;
      if (replayedId && await pgTurnIdSeen(client, userId, replayedId, schema)) {
        await client.query('ROLLBACK');
        return 'duplicate';
      }
    }
    // RECONCILIATION, write side: drain older buffered turns FIRST so a healed
    // transcript keeps its order — the user turn from a moment ago may sit in the
    // buffer while this assistant turn finds Postgres healthy again.
    const replayedIds = await replayBufferedEntries(client, ident, sessionId, schema);
    for (const entry of entries) {
      await insertEntry(client, userId, sessionId, entry, schema);
    }
    // Retention bound, atomic with the inserts above (round 5, note 56601).
    await pruneOldTurns(client, userId, sessionId);
    await pruneOldReceipts(client, userId, schema);
    await client.query(
      `UPDATE dashboard_studio_meta_data.chat_sessions
          SET updated_at = NOW()
        WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    await client.query('COMMIT');
    clearReplayed(ident, replayedIds);
    return 'appended';
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
  activeTurnTtlMs?: number,
): Promise<ChatStoreResult> {
  // A demo identity NEVER reaches Postgres, even when handed a live pool
  // (review !62 round 2, Critical 1). Enforced HERE, in the store, so no route
  // wiring mistake can read the tenant's persisted transcript into a demo
  // session — or replay a demo buffer out of memory into their database.
  // Whether we fell back to memory because Postgres FAILED, as opposed to because
  // this identity legitimately has no Postgres store (review !62 round 13,
  // Important 1). Only the latter can speak for whether a turn is running.
  let pgReadFailed = false;
  if (pool && !ident.demo) {
    try {
      const schema = await probeChatSchema(pool);
      if (schema.tables) {
        return await pgLoadHistory(pool, ident, sessionId, schema, activeTurnTtlMs);
      }
      // probeChatSchema swallows its own errors and reports all-false, so
      // `known` is the only thing that separates "this tenant has no chat tables"
      // from "we could not find out" (review !62 round 12, Important 2). Without
      // this check a failed probe would still answer awaitingReply from an empty
      // buffer — the very claim round 13 is about.
      pgReadFailed = !schema.known;
    } catch (error) {
      pgReadFailed = true;
      logger.warn('chatStore.loadHistory degraded to in-memory history', {
        error: toErrorMeta(error).message,
      });
    }
  }
  return memoryLoad(ident, activeTurnTtlMs, { authoritative: !pgReadFailed });
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
 * NEVER THROWS. For the UNGUARDED append — the assistant result, which is what this
 * rule is about — any Postgres failure (including a read-only standby refusing the
 * INSERT) degrades to the in-memory path, which since MR !61's review is a
 * WRITE-BEHIND BUFFER, not a dead end: the next healthy Postgres touch (load or
 * append) transactionally replays buffered turns into the resolved session.
 *
 * That is BEST-EFFORT (!65 round 12 — this used to say a partial failure "can never
 * orphan an assistant result"). The buffer is bounded and process-local, so an
 * eviction or a restart can lose it before any healthy touch arrives.
 *
 * Nor is the answer itself safe, which is the OTHER half of the old sentence and was
 * still standing here as "what always holds" (!65 round 14). This append runs BEFORE
 * the route responds — routes/agent.ts:359, then res.json at :364 — so "the result
 * already reached the user" is not yet true at the moment of buffering, and a crash in
 * that gap loses the answer and the transcript entry together.
 *
 * So the reason this path degrades and the guarded one does not is NOT a delivery
 * guarantee. It is that refusing would be strictly worse: the guarded refusal exists to
 * protect the single-active-turn lock, and an unguarded turn has no lock to protect.
 * Buffering it may save the transcript entry and costs nothing; refusing it would drop
 * that entry for certain and gain nothing.
 *
 * A GUARDED append (rejectWhenTurnActive — the user turn) does NOT always degrade,
 * and saying "any Postgres failure degrades" here was wrong (!65 round 10). It FAILS
 * CLOSED with 'unavailable', buffering nothing, from EITHER origin — an unresolved
 * capability probe, or a failed write on a receipts-capable tenant (!65 round 12
 * caught this naming only the second) — because the memory path cannot see a receipt
 * another replica may hold. That is deliberate, and on the second origin it is also
 * how a user turn gets orphaned when the failure was an in-doubt COMMIT. See
 * AppendOutcome, docs/ai-agent-seam.md §7, and the 'unavailable' branch in
 * routes/agent.ts.
 */
export async function appendTurns(
  pool: Pool | null, ident: ChatIdentity, sessionId: string, turns: AgentTurn[],
  options?: AppendOptions,
): Promise<AppendOutcome> {
  // Entry ids and timestamps are minted HERE, before any storage decision, so the
  // same identity follows a turn wherever it lands — memory today, Postgres on
  // replay tomorrow — and ON CONFLICT (id) DO NOTHING makes double-insertion
  // structurally impossible.
  let at = Date.now();
  const entries: StoredTurn[] = turns.map((turn) => ({ id: randomUUID(), at: at++, turn }));
  // Same demo override as loadHistory (review !62 round 2, Critical 1): a demo
  // turn must be structurally unable to reach chat_messages.
  if (pool && !ident.demo) {
    // Tracked outside the try so the catch below can tell "we know this tenant
    // has receipts, so the guard was supposed to be authoritative" from "we never
    // got far enough to know" (review !62 round 11, Important 2).
    let receiptsKnownPresent = false;
    try {
      const schema = await probeChatSchema(pool);
      receiptsKnownPresent = schema.receipts;
      // CAPABILITY UNKNOWN IS NOT CAPABILITY ABSENT (review !62 round 12,
      // Important 2). A probe that failed with nothing cached tells us nothing
      // about this tenant — and the memory path cannot see a Postgres receipt an
      // active turn may already hold, so degrading here would let each replica
      // admit its own turn. Refuse the GUARDED turn only; everything else still
      // degrades, because an unguarded turn has no lock to bypass and buffering it is
      // the best outcome available — NOT because a buffered reply is safe (!65 round
      // 14; the buffer is bounded and this append precedes the route's res.json).
      if (!schema.known && options?.rejectWhenTurnActive) {
        return 'unavailable';
      }
      if (schema.tables) {
        // 'busy'/'duplicate' are DECISIONS, not failures: returning them straight
        // through is what keeps a refused turn from falling into the memory path
        // and being written there anyway.
        return await pgAppendTurns(pool, ident, sessionId, entries, schema, options);
      }
    } catch (error) {
      logger.warn('chatStore.appendTurns degraded to in-memory history', {
        error: toErrorMeta(error).message,
      });
      // FAIL CLOSED for a guarded append on a receipts-capable tenant (round 11,
      // Important 2). The memory buffer knows nothing about the receipt this
      // tenant's OTHER turn may have written, so degrading here would admit a
      // second concurrent turn that bypassed the lock outright. Refusing costs a
      // failed send during a database outage; admitting corrupts a stateful
      // dialogue for every tab.
      //
      // Only for the GUARDED (user) turn: the assistant turn still degrades to the
      // write-behind buffer. Refusing it would drop the transcript entry for certain;
      // buffering makes it best-effort (!65 round 14 — this read "or a completed reply
      // would be lost", which casts the buffer as the thing that saves it).
      if (options?.rejectWhenTurnActive && receiptsKnownPresent) {
        return 'unavailable';
      }
    }
  }
  return memoryAppend(ident, sessionId, entries, options);
}

/**
 * DURABLE per-turn status lookup (review !62 round 7, finding 5b). Answers "what
 * happened to the turn I sent with this client_turn_id?" from the receipts table,
 * which is NOT pruned with the capped transcript — so a delivered turn evicted
 * from the newest-100 window is still confirmable. Absence from the transcript
 * alone is not proof of non-delivery; this is.
 *
 * NEVER rejects. Returns supported:false for demo/no-pool/older-schema tenants —
 * there the client keeps its transcript-based reconciliation, and 'unknown' says
 * nothing. supported:true with 'unknown' means the turn genuinely never reached
 * the server (within the 7-day receipt window). Scoped to the auth user, so one
 * tenant can never probe another's turn ids.
 */
export async function getTurnStatus(
  pool: Pool | null, ident: ChatIdentity, clientTurnId: string,
): Promise<TurnStatusResult> {
  if (!pool || ident.demo) return { status: 'unknown', supported: false };
  try {
    const schema = await probeChatSchema(pool);
    if (!schema.receipts) return { status: 'unknown', supported: false };
    return await withTransientRetry('chatStore.turnStatus', async () => {
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT status FROM dashboard_studio_meta_data.chat_turn_receipts
            WHERE client_turn_id = $1 AND user_id = $2`,
          [clientTurnId, ident.userId],
        );
        const status = res.rows[0]?.status;
        if (status === 'received' || status === 'answered') {
          return { status, supported: true };
        }
        return { status: 'unknown', supported: true };
      } finally {
        client.release();
      }
    });
  } catch (error) {
    logger.warn('chatStore.getTurnStatus failed; treating as unsupported', {
      error: toErrorMeta(error).message,
    });
    return { status: 'unknown', supported: false };
  }
}

/**
 * POST /api/agent/chat and GET /api/agent/session (DO-313).
 *
 * The route owns everything the AgentService seam deliberately does not: request
 * validation, session_id, the transcript (chatStore), the wall-clock deadline, the
 * per-user rate limit, the validateDashboard gate and the HTTP status taxonomy —
 * and the persist-never-refetch rule (§3.4.6) that makes S3 expiry a non-risk.
 *
 * Status taxonomy (D14): 400 = bad request body. 500 = deploy misconfiguration.
 * EVERYTHING else — AWS faults, S3 faults, off-contract replies, validateDashboard
 * rejections — is HTTP 200 with type:'error', in band. Throwing would route through
 * errorHandler, which emits {error:{code,message}} and loses session_id, and
 * `502 >= 500` destroys the message text anyway (C7). A transient throttle must not
 * kill the dialogue.
 */
import { Router } from 'express';
import type { Response } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler, CustomError } from '../middleware/errorHandler.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { agentService } from '../services/agent/index.js';
import { loadHistory, appendTurns, getTurnStatus, tenantKeyFor } from '../services/agent/chatStore.js';
import type { ChatIdentity, ChatStoreResult } from '../services/agent/chatStore.js';
import { validateDashboard } from '../services/agent/validateDashboard.js';
import { withoutArtifactUrls } from '../services/agent/stripArtifactUrl.js';
import { envInt } from '../services/agent/artifactStore.js';
import type { AgentTurn, AgentSessionResponse } from '../services/agent/types.js';

const router = Router();

// envInt, not Number() (self-review of !61): Number('180s') is NaN and Number('') is 0,
// and AbortSignal.timeout(NaN) throws a bare RangeError — no statusCode, so errorHandler
// returns an opaque 500 on EVERY chat request, after the user turn is already persisted,
// bypassing the in-band taxonomy this route exists to enforce; timeout(0) aborts on the
// first tick. envInt falls back on anything that is not a timer-safe positive integer
// (fractions throw ERR_OUT_OF_RANGE, values past 2^31-1 clamp to ~1 ms on the Node 22
// deploy image — MR !61 review) — the same way bedrockAgent reads its own tuning knobs.
const AGENT_TIMEOUT_MS = envInt(process.env.AGENT_TIMEOUT_MS, 180_000);
/**
 * How long an unanswered user turn keeps its session locked to a single active
 * turn (review !62 round 10, Important 3/4).
 *
 * DERIVED from the agent deadline, never a standalone number: below it, a turn
 * that is legitimately still running would stop counting and a second POST would
 * be admitted — exactly the concurrency this exists to prevent. The margin
 * covers the gap between the deadline firing and the error turn being persisted.
 * Above it, an unanswered turn is treated as abandoned (a crashed process, or an
 * agent call that timed out without persisting a reply), so a dead turn cannot
 * wedge the session forever.
 */
const ACTIVE_TURN_TTL_MS = AGENT_TIMEOUT_MS + 20_000;
export const MAX_MESSAGE_LENGTH = 4_000; // exported: the composer mirrors it (MR 5)
// A client-minted UUID is 36 chars; cap generously but bound the free-form,
// client-supplied value that lands in a TEXT column (review !62 round 6).
const MAX_CLIENT_TURN_ID_LENGTH = 100;

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Key on tenant + userId, never req.ip — and never BARE userId: it is only unique
  // within one tenant's database, and login trusts any presented userDbUrl, so a bare
  // userId key lets one tenant sit in (or drain) another's bucket (MR !61 review; see
  // ChatIdentity in chatStore.ts). The tenant half is the NORMALIZED pool identity,
  // not the raw URL — a raw-URL hash let ?application_name=1, =2, … mint a fresh
  // bucket per login, an unlimited-Bedrock-calls bypass (round 3, note 56573).
  // A key that is not an IP sidesteps the library's
  // IP-address validation family entirely (verified against the pinned 7.5.1 dist: it
  // validates request-IP handling — ERR_ERL_INVALID_IP_ADDRESS and friends — and the
  // keyGenerator-IPv6 check documented for newer releases does not exist in this
  // version). authenticateToken runs at the mount point, so user is always present —
  // 'anonymous' is unreachable and exists to satisfy the type.
  keyGenerator: (req) => {
    const user = (req as AuthenticatedRequest).user;
    return user ? `${tenantKeyFor(user.userDbUrl)}:${user.userId}` : 'anonymous';
  },
  // Mirrors the global limiter's localhost-in-development exemption (index.ts:125-129).
  // Without it, local testing of the chat loop hits 20/min almost immediately.
  // CONSEQUENCE: to exercise the 429 locally you must unset NODE_ENV=development.
  skip: (req) => !!(process.env.NODE_ENV === 'development' &&
    (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip?.startsWith('::ffff:127.0.0.1'))),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many chat messages. Please wait a moment.' } },
});

export interface ChatBody { session_id: string | null; message: string; client_turn_id: string | null }

/**
 * Map a store result onto the GET /session wire body.
 *
 * Exported so the ONE thing that is easy to get wrong here is testable without
 * supertest: `awaiting_reply` must be OMITTED — never sent as `false` — when the
 * store could not determine it (review !62 round 13, Important 1).
 *
 * The client treats any boolean in that field as the server's final word and
 * stops deriving the state from the transcript. Round 12 typed the store's
 * verdict as a plain boolean, so a tenant with no usable receipts table
 * (including 003-without-004) and a read that failed both answered `false` —
 * switching off the client's only remaining guard on exactly the tenants whose
 * SERVER-side guard is also off. Absence is what puts the fallback back.
 *
 * It is also where the artifact URL leaves the transcript (review !62 round 16,
 * Important). Stripping it as the turn is BUILT covers only turns built from now
 * on: rows already in chat_messages come back verbatim through rowToTurn, so
 * every conversation saved before that shipped — and every reply an old replica
 * writes during a rolling deploy — re-published the bucket on the next page load.
 * Here catches both stores at once, since both arrive as one ChatStoreResult, and
 * the rows themselves are left untouched.
 */
export function buildSessionResponse(result: ChatStoreResult): AgentSessionResponse {
  return {
    session_id: result.sessionId,
    persisted: result.persisted,
    // supports_turn_ids (review !62 round 7, finding 5a): an EXPLICIT capability so
    // the client trusts id reconciliation from the server's own answer, not from
    // inferring "some visible row has an id" (which breaks when only legacy rows show).
    supports_turn_ids: result.supportsTurnIds,
    // AUTHORITATIVE when present (review !62 round 12, Important 4): the client
    // locks its composer on THIS rather than re-deriving it from the transcript,
    // where an abandoned turn has no age and so never stops looking active.
    ...(result.awaitingReply !== undefined && { awaiting_reply: result.awaitingReply }),
    messages: withoutArtifactUrls(result.history),
  };
}

/** Throws CustomError(…, 400) — the ONLY things that 400 (§3.2). 400 < 500, so the
 *  message survives errorHandler (C7). Pure; no req, no res, no I/O. */
export function validateChatBody(body: unknown): ChatBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CustomError('Request body must be a JSON object', 400);
  }
  const b = body as Record<string, unknown>;

  if (b.message === undefined || b.message === null) {
    throw new CustomError('message is required', 400);
  }
  if (typeof b.message !== 'string') {
    throw new CustomError('message must be a string', 400);
  }
  const message = b.message.trim();
  if (!message) {
    throw new CustomError('message must not be empty', 400);
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new CustomError(`message must be at most ${MAX_MESSAGE_LENGTH} characters`, 400);
  }

  if (b.session_id !== undefined && b.session_id !== null && typeof b.session_id !== 'string') {
    throw new CustomError('session_id must be a string', 400);
  }

  // client_turn_id (review !62 round 6): client-minted, and REQUIRED since round
  // 11 (Important 2). It was optional, and an absent id meant no receipt was
  // written — which left the single-active-turn guard with nothing to see, so a
  // second concurrent request was simply admitted. The guard's state IS the
  // receipt, so the id is not decoration: without it there is no lock. Bound its
  // length — it is free-form and lands in a TEXT column — but do NOT require a
  // UUID shape; the server only stores and echoes it.
  if (typeof b.client_turn_id !== 'string' || !b.client_turn_id) {
    throw new CustomError('client_turn_id is required', 400);
  }
  if (b.client_turn_id.length > MAX_CLIENT_TURN_ID_LENGTH) {
    throw new CustomError(
      `client_turn_id must be at most ${MAX_CLIENT_TURN_ID_LENGTH} characters`,
      400,
    );
  }
  const clientTurnId: string = b.client_turn_id;

  return {
    session_id: (b.session_id as string | null | undefined) ?? null,
    message,
    client_turn_id: clientTurnId,
  };
}

router.post('/chat', chatLimiter, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user?.userId) throw new CustomError('User not authenticated', 401);

  const { session_id, message, client_turn_id } = validateChatBody(req.body);

  // Tenant-scoped identity for every piece of cross-tenant shared state (MR !61
  // review, Critical) — see ChatIdentity in chatStore.ts. userDbUrl is guaranteed
  // present: authenticateToken 401s without it (middleware/auth.ts:47). The demo
  // flag is part of the identity (review !62 round 2, Critical 1): the store
  // namespaces demo transcripts away from the real user's write-behind buffer
  // and refuses Postgres for them — without it, demo turns joined the buffer
  // replay and landed in the tenant's database.
  const ident: ChatIdentity = {
    tenantKey: tenantKeyFor(req.user.userDbUrl),
    userId: req.user.userId,
    demo: req.user.demo === true,
  };

  // Demo sessions must never touch the tenant settings DB (D11 amendment,
  // review !62 major 4): the demo banner promises "no modifications will be
  // saved to the database", and the JWT's userDbUrl is the customer's REAL
  // settings database — auth attaches a live pool for demo users too. Passing
  // null routes the chat store to its per-process in-memory path, read and
  // write, so demo transcripts never create rows (and never read the real
  // user's persisted history). GET /session then reports persisted:false,
  // which is truthful for demo. Since review !62 round 2 the store enforces
  // this itself off ident.demo; the null here is a second, independent layer.
  const pool = req.user.demo ? null : (req.settingsPool ?? null);

  // --- session resolution. THE SERVER IS AUTHORITATIVE (D13). An unknown, expired or
  // foreign id silently yields a fresh session. NEVER 400, NEVER 404 — that is what makes
  // the in-memory fallback survivable across restarts and replicas (worst case: an empty
  // transcript). Resolving here, BEFORE the service call, also guarantees the Bedrock impl
  // always receives a stable string in ctx.sessionId.
  //
  // settingsPool may be absent; history then degrades to in-memory. A chat must never 500
  // because a pool is missing — a deliberate divergence from the chart-catalog.ts:14-16
  // idiom, which throws.
  //
  // NOTE: this is the CHAT session. It is unrelated to req.user.session_id
  // (middleware/auth.ts:15), which is the AUTH session. Do not conflate them.
  const { sessionId, history } = await loadHistory(pool, ident, session_id);

  // Persist the user turn BEFORE calling the agent, so the transcript is coherent even
  // when the turn ends in type:'error'. Carry the client's idempotency id (review !62
  // round 6) so GET /session can hand it back and the browser reconciles a lost
  // response by id. Conditional spread keeps exactOptional types happy.
  //
  // SINGLE ACTIVE TURN PER SESSION (review !62 round 10, Important 3/4). Every
  // client-side guard against a second concurrent turn — the server-derived
  // composer lock, the authoritative pre-send probe, the cross-tab session ender —
  // is per-tab and best-effort: two tabs are not synchronized, a transient GET
  // failure leaves one unable to tell, and an identical repeat login used to
  // produce a token that fired no storage event at all. Bedrock keys its
  // conversation memory server-side on sessionId, so a second concurrent turn
  // corrupts the dialogue for BOTH tabs. This is the last line, at the one place
  // that sees every tab. The check runs inside the append's own transaction behind
  // the session row lock, so it cannot be raced by a concurrent POST.
  const started = await appendTurns(
    pool, ident, sessionId,
    [client_turn_id
      ? { role: 'user', content: message, client_turn_id }
      : { role: 'user', content: message }],
    { rejectWhenTurnActive: true, activeTurnTtlMs: ACTIVE_TURN_TTL_MS },
  );
  if (started === 'busy') {
    // 409, not 429: a state conflict on the session, not rate limiting. This
    // request wrote nothing — the guard rolls back before any INSERT.
    //
    // DO NOT describe what the client does next as a case list. !65 rounds 9, 10
    // and 11 each went on a version of that, and each list was incomplete. Two
    // separate questions are answered elsewhere:
    //
    //   IS A REPLY ACTUALLY COMING? The message below assumes so. True whenever a
    //   turn really is in flight — a new id while another runs, a same-id retry of
    //   a turn still running, or an already-ANSWERED id refused because some OTHER
    //   id is active (pgHasActiveTurn is probed before pgTurnIdSeen, so 'busy'
    //   outranks 'duplicate'). FALSE when the "active" turn is an orphan (see
    //   'unavailable' below): nothing is running, nothing will land, and after the
    //   TTL the same id turns into 'duplicate'.
    //
    //   DOES THE DRAFT COME BACK? Only on an AUTHORITATIVE confirmed-lost: session
    //   reads that succeeded and, on the id path, a SUPPORTED receipt reading
    //   'unknown' inside the retention window. Everything else is 'uncertain' —
    //   the mutation is kept, the composer LOCKS, no draft. That covers a failed
    //   read, an unavailable or expired receipt, and notably the MEMORY/DEMO
    //   tenant, which reports supportsTurnIds TRUE while getTurnStatus answers
    //   supported:false, so the id path is taken and cannot conclude. See
    //   turnDelivery.ts — reconcileReceiptOutcome, locksComposerAwaitingReply.
    //
    // In short: this branch knows it wrote nothing. It does not know what the user
    // will see, and every attempt to say so from here has been wrong.
    throw new CustomError(
      'Another message in this chat is still being answered. Wait for the reply before sending again.',
      409,
    );
  }
  if (started === 'duplicate') {
    // A client_turn_id this user has already used (review !62 round 11). Admitting
    // it would double-feed the stateful agent AND leave the guard blind, since no
    // new 'received' receipt is ever written for an id that already exists.
    throw new CustomError(
      'This message was already sent. Reload the page to see its reply.',
      409,
    );
  }
  if (started === 'unavailable') {
    // The guard could not be evaluated on a tenant whose lock is supposed to be
    // authoritative (round 11, Important 2). Refusing is deliberate: admitting the
    // turn would bypass the lock entirely.
    //
    // What 'unavailable' guarantees is that nothing was BUFFERED — appendTurns skips
    // memoryAppend on this path. It does NOT guarantee nothing was written (!65 round
    // 8): the store returns it from a catch an in-doubt COMMIT can reach, so on a
    // receipts-capable tenant this turn and its 'received' receipt may ALREADY be in
    // Postgres.
    //
    // KNOWN LIMITATION, and do not re-add the reassurance this replaced (!65 round 9
    // — round 8's "retrying is safe, the same id comes back 'duplicate'" was wrong in
    // both halves). We return 503 BEFORE agentService.chat below, so the agent never
    // ran and no reply will ever arrive. A retry hits pgHasActiveTurn — which is
    // probed BEFORE pgTurnIdSeen — and the live 'received' receipt makes it 'busy',
    // then 'duplicate' once the TTL lapses; neither dispatches the agent. The client
    // meanwhile reads the receipt as delivered, locks the composer and tells the user
    // the reply may appear later. It will not. Recovering the turn needs resumable
    // dispatch (re-enter the agent call for a 'received' receipt with no assistant
    // turn), which does not exist yet. See docs/ai-agent-seam.md §7.
    throw new CustomError(
      'The chat is temporarily unavailable. Please try again in a moment.',
      503,
    );
  }

  // --- THE ROUTE OWNS THE DEADLINE (D21). One place; the mock inherits it for free; the
  // Bedrock impl forwards it verbatim to BOTH client.send(command, {abortSignal}) and the
  // S3 GetObject, so the artifact fetch is inside the same budget.
  // AbortSignal.timeout only (Node 17.3+). AbortSignal.any() became AVAILABLE when the image
  // moved to node:22-alpine (MR !57 review round 2), but client-abort propagation stays a
  // deliberate non-goal (MR 3 §5) — do not bolt it on in passing; if the product wants
  // abort-on-navigate, take it as its own change with its own tests.
  //
  // NOTE: the signal is HANDED to the implementation, not RACED against the call. An
  // implementation that ignores it (the mock does, deliberately) cannot be aborted by it.
  const out = await agentService.chat(
    { message, history },
    { userId: req.user.userId, role: req.user.role, sessionId,
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) },
  );

  // --- HARD GATE on every type:'result' from EITHER implementation (D12). The mock passes
  // because the gate's error/warning boundary was CALIBRATED against the 14 shipped fixtures — so it
  // costs nothing today and proves nothing about a real LLM. It is a SAFETY gate, never a
  // CORRECTNESS gate: the agent's own hallucinated column passed every static check we have
  // and failed only at execution. Preview-before-Apply is the real control.
  let turn = out;
  if (out.type === 'result' && out.result) {
    const { errors, warnings } = validateDashboard(out.result.report_schema);
    if (warnings.length) logger.warn('Agent dashboard warnings', { sessionId, warnings });
    if (errors.length) {
      logger.error('Agent produced an invalid dashboard', { sessionId, errors });
      turn = {
        type: 'error',
        message: 'I generated a dashboard but it failed validation. Please rephrase your request.',
        result: null,
      };
    }
  }

  // PERSIST THE FULL RESULT (§3.4.6). turn.result carries the complete dashboard JSON that
  // the Bedrock service already fetched from S3. It is written here ONCE and never
  // re-fetched: preview, apply, history load and page reload all read this row. An expired
  // S3 object can therefore never 404 a conversation the user is re-reading.
  // AgentTurn is a discriminated union (§3.1), so the assistant turn is built per arm —
  // spreading turn.type/turn.result into one literal does not type-check.
  //
  // Stamp the reply with the ORIGINATING client_turn_id (review !62 round 7, finding
  // 3): the client then matches the exact user↔reply pair instead of "any later
  // assistant", so a concurrent turn's reply landing first cannot be mistaken for
  // ours. Conditional spread keeps exactOptional types happy.
  const idField = client_turn_id ? { client_turn_id } : {};
  const assistantTurn: AgentTurn = turn.type === 'result'
    ? { role: 'assistant', type: 'result', content: turn.message, result: turn.result, ...idField }
    : { role: 'assistant', type: turn.type, content: turn.message, result: null, ...idField };
  await appendTurns(pool, ident, sessionId, [assistantTurn]);

  // The route stamps session_id. The service never sees it. The response is a bare
  // object (the locked wire contract), not the {success: true, …} envelope app.ts
  // uses — api.ts's request<T> returns the body on 2xx unconditionally.
  return res.json({ session_id: sessionId, ...turn });
}));

// Rehydrates the single continuous dialogue on page load. Without it, an applied
// 002_add_chat_tables.sql is write-only — a DBA runs the migration and observes nothing (D16).
// persisted: false tells the UI this tenant has not applied 002 and history lives in process
// memory — it survives page reloads but not a backend restart, a replica switch or the 2 h
// TTL; it says NOTHING about the agent's memory, which Bedrock holds server-side either
// way (D19). Result turns are returned with their `result` payload attached — that is what
// makes a reloaded transcript re-previewable with zero S3 traffic.
router.get('/session', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user?.userId) throw new CustomError('User not authenticated', 401);
  const ident: ChatIdentity = {
    tenantKey: tenantKeyFor(req.user.userDbUrl),
    userId: req.user.userId,
    demo: req.user.demo === true,
  };
  // Same demo guard as POST /chat above: demo history lives in its own process-
  // memory namespace, so demo reads must not surface the real user's persisted
  // transcript (or their degraded-mode buffer — review !62 round 2, Critical 1).
  const pool = req.user.demo ? null : (req.settingsPool ?? null);
  const result =
    // Same TTL the POST path guards with, so the client and the server can never
    // disagree about whether a turn is still running (round 12, Important 4).
    await loadHistory(pool, ident, null, ACTIVE_TURN_TTL_MS);
  return res.json(buildSessionResponse(result));
}));

// DURABLE per-turn status (review !62 round 7, finding 5b). The client calls this
// during lost-response reconciliation when the turn's id is no longer in the capped
// transcript — absence from the newest-100 window is not proof of non-delivery. Reads
// the receipts table (kept outside that window), scoped to the auth user.
router.get('/turn-status', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user?.userId) throw new CustomError('User not authenticated', 401);
  const raw = req.query.client_turn_id;
  const clientTurnId = typeof raw === 'string' ? raw : '';
  if (!clientTurnId) throw new CustomError('client_turn_id is required', 400);
  if (clientTurnId.length > MAX_CLIENT_TURN_ID_LENGTH) {
    throw new CustomError(`client_turn_id must be at most ${MAX_CLIENT_TURN_ID_LENGTH} characters`, 400);
  }
  const ident: ChatIdentity = {
    tenantKey: tenantKeyFor(req.user.userDbUrl),
    userId: req.user.userId,
    demo: req.user.demo === true,
  };
  const pool = req.user.demo ? null : (req.settingsPool ?? null);
  const { status, supported } = await getTurnStatus(pool, ident, clientTurnId);
  return res.json({ status, supported });
}));

export default router;

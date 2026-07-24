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
import type { ChatIdentity } from '../services/agent/chatStore.js';
import { validateDashboard } from '../services/agent/validateDashboard.js';
import { envInt } from '../services/agent/artifactStore.js';
import type { AgentTurn } from '../services/agent/types.js';

const router = Router();

// envInt, not Number() (self-review of !61): Number('180s') is NaN and Number('') is 0,
// and AbortSignal.timeout(NaN) throws a bare RangeError — no statusCode, so errorHandler
// returns an opaque 500 on EVERY chat request, after the user turn is already persisted,
// bypassing the in-band taxonomy this route exists to enforce; timeout(0) aborts on the
// first tick. envInt falls back on anything that is not a timer-safe positive integer
// (fractions throw ERR_OUT_OF_RANGE, values past 2^31-1 clamp to ~1 ms on the Node 22
// deploy image — MR !61 review) — the same way bedrockAgent reads its own tuning knobs.
const AGENT_TIMEOUT_MS = envInt(process.env.AGENT_TIMEOUT_MS, 180_000);
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

  // client_turn_id (review !62 round 6): optional, client-minted. Bound its length
  // — it is free-form and lands in a TEXT column — but do NOT require a UUID shape;
  // the server only stores and echoes it. An empty string means "none".
  let clientTurnId: string | null = null;
  if (b.client_turn_id !== undefined && b.client_turn_id !== null) {
    if (typeof b.client_turn_id !== 'string') {
      throw new CustomError('client_turn_id must be a string', 400);
    }
    if (b.client_turn_id.length > MAX_CLIENT_TURN_ID_LENGTH) {
      throw new CustomError(
        `client_turn_id must be at most ${MAX_CLIENT_TURN_ID_LENGTH} characters`,
        400,
      );
    }
    clientTurnId = b.client_turn_id || null;
  }

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
  await appendTurns(pool, ident, sessionId, [
    client_turn_id
      ? { role: 'user', content: message, client_turn_id }
      : { role: 'user', content: message },
  ]);

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
  const { sessionId, history, persisted, supportsTurnIds } = await loadHistory(pool, ident, null);
  // supports_turn_ids (review !62 round 7, finding 5a): an EXPLICIT capability so
  // the client trusts id reconciliation from the server's own answer, not from
  // inferring "some visible row has an id" (which breaks when only legacy rows show).
  return res.json({
    session_id: sessionId,
    persisted,
    supports_turn_ids: supportsTurnIds,
    messages: history,
  });
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

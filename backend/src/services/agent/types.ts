/**
 * Wire + internal contract for the AI dashboard agent (DO-313 / DO-342).
 *
 * The wire types are the PUBLIC contract of POST /api/agent/chat and GET
 * /api/agent/session, mirrored in src/types/agent.ts. Changing one side without
 * the other is a breaking change: the frontend is written against this shape and
 * MUST NOT change when the mock is replaced by the Bedrock-backed service.
 */
export type AgentChatType = 'question' | 'result' | 'error';

/** `report_schema` is the FLAT Grafana-compatible dashboard JSON described by
 *  src/types/dashboard-types.ts:6-29 (panel type union at :267-279), as rendered
 *  by the DashboardRenderer dispatch at DashboardRenderer.tsx:1932-1956.
 *  NOT src/renderer-core/schema/grafana-dashboard.ts — that file is DEAD, its
 *  {dashboard, "x-navixy"} wrapper matches no fixture, and its 7-value union
 *  omits row/bargauge/kpi/timeseries. Never point the agent spec at it.
 *
 *  `title` is DERIVED, never emitted separately by the agent: it is
 *  report_schema.title when that is a non-empty string, else the uid, else
 *  'Untitled dashboard'. See §3.4.8. */
export interface AgentChatResult {
  title: string;
  report_schema: Record<string, unknown>;
}

/** POST /api/agent/chat request body. */
export interface AgentChatRequest {
  /** Omit or null on the first turn. The SERVER is authoritative (D13): an
   *  unknown id silently yields a fresh session. It never 400s or 404s. */
  session_id?: string | null;
  message: string;
  /** Client-minted idempotency id for THIS user turn (DO-313 review !62 round 6).
   *  The browser mints a UUID per send; the server persists it on the user turn
   *  and returns it in GET /session, so the client reconciles a lost HTTP
   *  response by id — deterministic — instead of by fragile content/occurrence
   *  counting, which cannot tell concurrent identical turns apart or survive the
   *  100-turn cap sliding. Optional and free-form (the route caps length only);
   *  an absent id degrades to the prior content-based reconciliation. */
  client_turn_id?: string | null;
}

/** POST /api/agent/chat 200 body. Note: type:'error' arrives with HTTP 200.
 *
 *  Discriminated on `type` so the compiler enforces what the contract says in
 *  prose: `result` is non-null exactly when type === 'result'. The wire JSON
 *  is unchanged by this shape. */
export type AgentChatResponse =
  | { session_id: string; type: 'question' | 'error'; message: string; result: null }
  | { session_id: string; type: 'result'; message: string; result: AgentChatResult };

/** One transcript turn. A union so the compiler enforces what used to be
 *  prose: `type` exists on assistant turns only, and `result` is non-null
 *  exactly on assistant turns of type 'result'.
 *
 *  `type` is the AgentChatType the turn had when it was delivered live,
 *  persisted so a reloaded transcript renders exactly as the live session
 *  did — a past 'error' must not come back as ordinary assistant prose.
 *  Absent on legacy assistant rows, which render as 'question'.
 *
 *  On the 'result' arm, `result` CARRIES THE FULL DASHBOARD JSON, NEVER THE
 *  s3:// URL. The artifact is fetched exactly once, at the moment the turn
 *  is produced, and persisted here. Preview, Apply, history load and page
 *  reload all read from here and NEVER re-fetch S3. See §3.4.6 and R28. */
//  `client_turn_id` (review !62 round 7, finding 3): the ORIGINATING user turn's
//  client id. Carried on the USER turn (the browser mints it) AND stamped onto
//  its assistant/error reply, so the client matches the exact user↔reply PAIR
//  instead of "any later assistant" — which mis-associates concurrent turns
//  ([user A, user B, reply B, reply A] is a legitimate interleave). NULL on
//  legacy rows and any turn sent without an id.
export type AgentTurn =
  | { role: 'user'; type?: never; content: string; result?: never; client_turn_id?: string }
  | { role: 'assistant'; type?: 'question' | 'error'; content: string; result?: null; client_turn_id?: string }
  | { role: 'assistant'; type: 'result'; content: string; result: AgentChatResult; client_turn_id?: string };

/** GET /api/agent/session 200 body. */
export interface AgentSessionResponse {
  session_id: string;
  /** false when this tenant has not applied 002_add_chat_tables.sql — history is
   *  process-local and will not survive a restart. The UI surfaces this as one
   *  line of copy; it never disables anything. NOTE (D19): it says nothing about
   *  the AGENT's memory, which Bedrock holds server-side either way. */
  persisted: boolean;
  /** EXPLICIT capability (review !62 round 7, finding 5a): whether this response's
   *  turns round-trip client_turn_id, so the client trusts id reconciliation
   *  instead of INFERRING support from "some visible row has an id" (which fails
   *  when the baseline GET failed and only legacy rows are visible). True for the
   *  in-memory path (it carries ids) and for Postgres WITH the round-6 column;
   *  false only for a tenant on an older 002 whose column is absent. */
  supports_turn_ids: boolean;
  messages: AgentTurn[];
}

/** GET /api/agent/turn-status?client_turn_id=… 200 body (review !62 round 7,
 *  finding 5b). A DURABLE per-turn receipt lookup, so a delivered turn evicted
 *  from the capped transcript can still be confirmed — absence from the 100-row
 *  window alone is not proof of non-delivery. */
export interface AgentTurnStatusResponse {
  /** 'received' — the user turn is persisted, no reply yet; 'answered' — its
   *  assistant/error reply landed; 'unknown' — no receipt found. */
  status: 'received' | 'answered' | 'unknown';
  /** Whether this tenant's schema has the durable receipts table. When false,
   *  'unknown' is uninformative and the client keeps its transcript fallback;
   *  when true, 'unknown' means the turn genuinely never reached the server
   *  (within the receipt retention window). */
  supported: boolean;
}

/** Per-request context. */
export interface AgentContext {
  userId: string;
  role: string;
  /** Stable across the whole dialogue, minted by the route. Passed VERBATIM to
   *  Bedrock as InvokeAgentCommand.sessionId — that is what its server-side
   *  conversation memory is keyed on (D19). Bedrock's pattern is
   *  [0-9a-zA-Z._:-]+, so a plain UUID is fine. */
  sessionId: string;
  /** The wall-clock deadline for the whole turn (D21). Owned by the route.
   *  Implementations MUST forward it to any outbound call — the Bedrock invoke
   *  AND the S3 fetch. The route does NOT race it against the call, so an
   *  implementation that ignores it cannot be aborted by it. */
  signal: AbortSignal;
}

export interface AgentTurnInput {
  message: string;
  /** Oldest-first, already truncated by the route.
   *
   *  READ BY THE MOCK. **IGNORED BY THE BEDROCK IMPLEMENTATION** — Bedrock keys
   *  conversation memory server-side on sessionId and receives only the newest
   *  turn. Feeding this back would double-feed every turn and degrade quality.
   *  It stays on the interface so the mock can be stateless and so a stateless
   *  agent remains implementable behind this seam without a contract change.
   *  See D19 and R18. */
  history: AgentTurn[];
}

/** Distributes Omit over each union arm — plain Omit over a union collapses
 *  the type/result discrimination. Internal helper, not part of the wire. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** session_id is deliberately absent: the route owns it, so an implementation
 *  cannot corrupt session handling. */
export type AgentTurnResult = DistributiveOmit<AgentChatResponse, 'session_id'>;

/**
 * The seam. Implementations MUST be storage-free and MUST be pure functions of
 * (input, ctx). Persistence lives behind chatStore, in the route.
 */
export interface AgentService {
  /** Diagnostic only — logged at boot. */
  readonly kind: 'mock' | 'bedrock';
  /** MUST NOT reject for agent-level failures: AWS faults, S3 faults,
   *  off-contract replies — everything a user can trigger comes back IN BAND
   *  as type:'error' (D14). A rejected promise here is a programming bug; the
   *  route lets it surface through errorHandler as a 500. */
  chat(input: AgentTurnInput, ctx: AgentContext): Promise<AgentTurnResult>;
}

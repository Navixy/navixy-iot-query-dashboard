/**
 * WIRE contract for the AI dashboard agent (DO-313 / DO-342) — frontend mirror.
 *
 * SOURCE OF TRUTH: backend/src/services/agent/types.ts.
 * These two files are one contract. Changing either without the other is a
 * BREAKING CHANGE and there is no compiler, test or CI step that will catch it —
 * the seam is a JSON HTTP body. If you edit this file, edit that one in the same
 * commit, and say so in the commit message.
 *
 * The backend's INTERNAL types (AgentContext, AgentTurnInput, AgentTurnResult,
 * AgentService) are deliberately absent: they carry Bedrock session ids, wall-clock
 * deadlines and S3 artifact locations, none of which the browser is told about.
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
export type AgentTurn =
  | { role: 'user'; type?: never; content: string; result?: never }
  | { role: 'assistant'; type?: 'question' | 'error'; content: string; result?: null }
  | { role: 'assistant'; type: 'result'; content: string; result: AgentChatResult };

/** GET /api/agent/session 200 body. */
export interface AgentSessionResponse {
  session_id: string;
  /** false when this tenant has not applied 002_add_chat_tables.sql — history is
   *  process-local and will not survive a restart. The UI surfaces this as one
   *  line of copy; it never disables anything. NOTE (D19): it says nothing about
   *  the AGENT's memory, which Bedrock holds server-side either way. */
  persisted: boolean;
  messages: AgentTurn[];
}

/**
 * One rendered row of the transcript. The transcript is a flat list of these,
 * built from two sources that must converge on one renderer: rehydrated history
 * from GET /api/agent/session, and turns produced live in this page session.
 */
export interface ChatBubble {
  /** Client-side only, for React keys. Not stable across reloads. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Present on assistant bubbles that carried a dashboard. Drives ResultSlot. */
  result?: AgentChatResult;
  /** Renders the bubble in the destructive style. Set for BOTH failure paths:
   *  transport failures (mutation onError) and in-band type:'error' (onSuccess). */
  isError?: boolean;
}

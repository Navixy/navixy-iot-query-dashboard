-- 002_add_chat_tables.sql — AI chat history (DO-313)
--
-- THIS FILE IS NOT APPLIED BY THE APPLICATION. There is no migration runner in this
-- repo. Apply out-of-band (DBA / deploy). 001_add_composite_reports.sql proves this
-- path rots silently — it was never applied and its table is never queried (composite
-- reports live in `reports`, see services/database.ts:1533-1534).
--
-- The backend therefore NEVER assumes these tables exist. It probes information_schema
-- (the house convention — services/database.ts:610, :667, :730) and falls back to
-- in-memory, per-process history when they are absent. Chat works on every tenant;
-- history only turns on where this ran.
--
-- DBA: confirm user_id matches the live dashboard_studio_meta_data.users.id type before
-- applying. This repo contains no DDL for the existing schema, so UUID is inferred from
-- the gen_random_uuid() conventions, not known. (Q1 / PF-4.)

CREATE TABLE IF NOT EXISTS dashboard_studio_meta_data.chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
);

-- DO-313 v1 ships exactly one continuous dialogue per user (D7: no "new chat" button, no
-- multi-session). Encoding that here makes get-or-create race-safe via ON CONFLICT DO
-- NOTHING. A future multi-session feature drops this index.
CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_one_active_per_user
  ON dashboard_studio_meta_data.chat_sessions (user_id) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS dashboard_studio_meta_data.chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- THE transcript order authority (MR !61 review round): the store replays
  -- outage-buffered turns transactionally before appending new ones, so insertion
  -- order IS conversation order — while created_at can tie (same-millisecond
  -- writes) or even step backwards (clock adjustments), which would let a
  -- user/assistant pair flip on read. Gaps are expected (ON CONFLICT DO NOTHING
  -- consumes values).
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  session_id  UUID NOT NULL
              REFERENCES dashboard_studio_meta_data.chat_sessions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  -- AgentChatType for assistant turns; NULL for user turns and legacy rows (render those
  -- as 'question'). Persisted so a reloaded transcript shows past errors as errors, not
  -- as ordinary assistant prose (post-review addition to MR 1's AgentTurn).
  type        TEXT CHECK (type IN ('question', 'result', 'error')),
  -- {title, report_schema} for assistant turns of type 'result'; NULL otherwise.
  --
  -- THIS HOLDS THE FULL DASHBOARD JSON, NEVER THE s3:// URL. The agent's artifacts are
  -- fetched once, at turn time, and copied here — they expire from S3 after a few months
  -- and a saved conversation outlives that. Budget ~5-50 KB per result turn.
  result      JSONB,
  -- WHEN the turn entered the store (the application supplies it), not when this row
  -- was written: a turn buffered through a Postgres outage keeps its truthful time on
  -- replay. Display metadata only — ordering uses seq.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_session_seq_idx
  ON dashboard_studio_meta_data.chat_messages (session_id, seq);

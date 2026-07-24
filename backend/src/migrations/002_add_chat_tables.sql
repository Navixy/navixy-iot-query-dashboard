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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Client-minted idempotency id for USER turns (DO-313 review !62 round 6). The
  -- browser sends a UUID per turn; GET /api/agent/session returns it so the client
  -- reconciles a lost POST response by id, not by fragile content/occurrence
  -- matching. NULL for assistant turns and for legacy rows. NOT unique — the row
  -- `id` above already dedups a replayed INSERT; this is read-side match data only.
  --
  -- BACKWARD COMPATIBLE: the backend probes information_schema.columns for this
  -- column and, when a tenant applied an EARLIER 002 without it, keeps persisting
  -- (writing NULL, reading it as absent) rather than downgrading to in-memory. A
  -- tenant on that older schema gets the column from the EXECUTABLE upgrade in
  -- 003_add_turn_receipts.sql (ALTER TABLE ... ADD COLUMN IF NOT EXISTS) — this
  -- CREATE-only definition never reaches them (review !62 round 7, finding 6).
  client_turn_id TEXT
);
-- RETENTION (DO-313 review round 5): the store keeps the newest 100 rows
-- (MAX_TURNS, chatStore.ts) per session — exactly what GET /api/agent/session can
-- ever return — pruning older rows inside the same transaction as every
-- append/replay, via this index. No DBA-side cleanup job is needed; the table is
-- bounded per user by construction. The prune derives its DELETE boundary from a
-- COUNT, so each write transaction first takes SELECT … FOR UPDATE on the
-- chat_sessions row (round 6): that serializes a user's concurrent writers — two
-- browser tabs, or a replay racing an append — so the bound stays strict instead
-- of leaking a row per collision.
CREATE INDEX IF NOT EXISTS chat_messages_session_seq_idx
  ON dashboard_studio_meta_data.chat_messages (session_id, seq);

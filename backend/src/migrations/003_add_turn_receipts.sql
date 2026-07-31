-- 003_add_turn_receipts.sql — executable client_turn_id upgrade + durable per-turn receipts
-- (DO-313 review !62 round 7). Apply AFTER 002.
--
-- Same out-of-band model as 002 (no migration runner in this repo — the backend probes
-- information_schema per tenant and degrades to in-memory / the content fallback when a piece
-- is absent). Everything here is idempotent, so re-running is safe on every tenant.

-- FINDING 6 — 002 put client_turn_id only inside CREATE TABLE IF NOT EXISTS, so a tenant that
-- already applied the earlier 002 never receives the column and stays on the unsound content
-- reconciliation. This ALTER is executable (the 002 note was only a comment). It is the piece
-- to include in the deployment path for existing tenants.
ALTER TABLE dashboard_studio_meta_data.chat_messages
  ADD COLUMN IF NOT EXISTS client_turn_id TEXT;

-- FINDING 5b — a DURABLE per-turn receipt, keyed by the client-minted id, kept OUTSIDE the
-- capped 100-row transcript (chat_messages is pruned to MAX_TURNS/session). Absence from the
-- transcript window alone is NOT proof of non-delivery: an uncertain-but-delivered turn can be
-- evicted by 100 newer turns while its mutation still lives on the client (gcTime: Infinity).
-- The client reconciles by looking this up (GET /api/agent/turn-status?client_turn_id=…) when
-- the turn is no longer visible in the transcript. Rows are tiny (id + status) and pruned by
-- recency, so this never grows like the content table.
CREATE TABLE IF NOT EXISTS dashboard_studio_meta_data.chat_turn_receipts (
  client_turn_id TEXT PRIMARY KEY,
  user_id        UUID NOT NULL,
  session_id     UUID,
  -- 'received' the moment the USER turn is persisted (before the multi-second agent call);
  -- 'answered' once the assistant/error turn for that same id lands. That pair IS finding 3's
  -- per-turn status, so completion is the exact user↔reply match, never "any later assistant".
  status         TEXT NOT NULL CHECK (status IN ('received', 'answered')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The prune DELETEs receipts older than a fixed window per user inside the append transaction,
-- so the table stays bounded by recency; this index serves both that DELETE and keeps the
-- primary-key lookup that GET /turn-status uses cheap.
CREATE INDEX IF NOT EXISTS chat_turn_receipts_user_updated_idx
  ON dashboard_studio_meta_data.chat_turn_receipts (user_id, updated_at);

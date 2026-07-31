-- 004_receipt_key_per_user.sql — scope the turn receipt key to the user
-- (DO-313 review !62 round 12, Important 3). Apply AFTER 003.
--
-- Same out-of-band model as 002/003 (no migration runner in this repo — the backend probes
-- information_schema per tenant and degrades when a piece is absent). Idempotent, so
-- re-running is safe on every tenant.
--
-- 003 gave chat_turn_receipts a GLOBAL primary key on client_turn_id, but every check that
-- reads it is scoped by user_id — the id is a client-minted string and the API deliberately
-- accepts arbitrary ones. The two scopes disagreeing is a cross-user defect, not a style
-- point: if user B sends a turn whose id user A is already using,
--
--   * B's duplicate check (scoped to B) finds nothing and admits the turn;
--   * B's user message row is written;
--   * B's receipt INSERT hits the GLOBAL key and does nothing, so B gets no receipt at all
--     and B's turn is unguarded;
--   * B's assistant reply then upgrades the matching row — which is A's — to 'answered',
--     releasing A's single-active-turn guard while A's turn is still running.
--
-- Making the key (user_id, client_turn_id) puts it in the same scope as every check.
-- Uniqueness is not weakened for anyone: the old key was unique on client_turn_id alone, so
-- no existing pair can collide and no rows need cleaning up first.
DO $$
DECLARE
  pk_columns TEXT[];
BEGIN
  SELECT array_agg(k.column_name::text ORDER BY k.column_name::text)
    INTO pk_columns
    FROM information_schema.table_constraints c
    JOIN information_schema.key_column_usage k
      ON k.constraint_name = c.constraint_name
     AND k.constraint_schema = c.constraint_schema
   WHERE c.constraint_schema = 'dashboard_studio_meta_data'
     AND c.table_name = 'chat_turn_receipts'
     AND c.constraint_type = 'PRIMARY KEY';

  -- Absent table (003 not applied) or already correct: nothing to do.
  IF pk_columns IS NULL OR pk_columns = ARRAY['client_turn_id', 'user_id'] THEN
    RETURN;
  END IF;

  ALTER TABLE dashboard_studio_meta_data.chat_turn_receipts
    DROP CONSTRAINT IF EXISTS chat_turn_receipts_pkey;
  ALTER TABLE dashboard_studio_meta_data.chat_turn_receipts
    ADD PRIMARY KEY (user_id, client_turn_id);
END $$;

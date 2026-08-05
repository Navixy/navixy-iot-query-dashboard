-- apply_ai_chat.sql — AI chat (DO-313): apply 002 + 003 + 004, then prove it worked.
--
-- WHAT THIS IS
--   One idempotent script that replaces handing over 002_add_chat_tables.sql,
--   003_add_turn_receipts.sql and 004_receipt_key_per_user.sql separately. Same DDL,
--   same order, plus the preflight checks and the verification those three files
--   leave to the operator. Re-running it is safe; on an up-to-date database it is a
--   no-op that just re-prints the report at the end.
--
-- WHO RUNS IT, AND HOW OFTEN
--   The owner of a TENANT SETTINGS DATABASE — the `userDbUrl` a customer supplies at
--   login — as a role that may CREATE in the `dashboard_studio_meta_data` schema.
--   Run it once PER TENANT. There is no shared settings database, and the application
--   contains no migration runner: it applies no DDL, ever, on any schedule.
--
-- WHAT HAPPENS IF IT IS NEVER RUN
--   Nothing breaks. Chat works without these tables — the backend probes
--   information_schema and keeps the transcript in process memory instead, so history
--   is lost on a restart or a replica switch. Under the Bedrock backend the AGENT
--   still remembers either way; its memory is held server-side. This is an upgrade,
--   not a release blocker, and it can be applied to tenants one at a time.
--
-- HOW TO RUN
--   psql "postgresql://USER:PASS@HOST:5432/DB" -v ON_ERROR_STOP=1 -f apply_ai_chat.sql
--
--   To also grant the application role its DML in the same pass, either uncomment the
--   SET line just below or run it in the SAME session before this script:
--       SET chat_migration.app_role = 'the_role_in_the_userDbUrl';
--   Leaving it unset is correct only when the application connects as the same role
--   that runs this script. See section 5.
--
-- SAFETY
--   Everything below runs in ONE transaction, and the verification in section 6
--   raises on any mismatch — so a partial apply rolls back rather than committing a
--   shape the application treats as broken. Locks are taken only on the three chat
--   tables; `users` is read, never modified.

BEGIN;

-- SET chat_migration.app_role = 'dashboard_settings';   -- <- uncomment + edit for grants


-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT — fail before any DDL, not after
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  users_id_type text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata
                  WHERE schema_name = 'dashboard_studio_meta_data') THEN
    RAISE EXCEPTION
      'Schema dashboard_studio_meta_data not found. This is not a tenant settings database — check that you connected with the userDbUrl and not the iotDbUrl.';
  END IF;

  SELECT data_type INTO users_id_type
    FROM information_schema.columns
   WHERE table_schema = 'dashboard_studio_meta_data'
     AND table_name   = 'users'
     AND column_name  = 'id';

  IF users_id_type IS NULL THEN
    RAISE EXCEPTION
      'dashboard_studio_meta_data.users.id not found. The chat tables key off that column; refusing to create tables that could never be joined to a real user.';
  END IF;

  -- chat_sessions.user_id and chat_messages.user_id hold users.id values. They carry
  -- NO foreign key (the application writes them from the JWT), but the TYPES still
  -- have to agree. This repo ships no DDL for the pre-existing schema, so UUID was
  -- INFERRED from the gen_random_uuid() conventions, not known. A mismatch is the
  -- worst possible failure here: every table below would be created successfully and
  -- every INSERT would then fail, and the backend swallows those failures into its
  -- in-memory path — so chat keeps working, persists nothing, and reports no error.
  IF users_id_type <> 'uuid' THEN
    RAISE EXCEPTION
      'dashboard_studio_meta_data.users.id is "%", but this migration assumes uuid. STOP and report the real type to the application team — do not adjust this script alone, the backend''s column types have to change with it.',
      users_id_type;
  END IF;

  BEGIN
    PERFORM gen_random_uuid();
  EXCEPTION WHEN undefined_function THEN
    RAISE EXCEPTION
      'gen_random_uuid() is unavailable on this server. PostgreSQL 13+ provides it natively; on 11/12 run: CREATE EXTENSION IF NOT EXISTS pgcrypto;';
  END;

  RAISE NOTICE 'preflight ok — users.id is uuid, gen_random_uuid() available';
END $$;


-- ---------------------------------------------------------------------------
-- 1. 002_add_chat_tables.sql — the transcript
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_studio_meta_data.chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
);

-- One continuous dialogue per user (D7: no "new chat" button, no multi-session).
-- Encoding it here is what makes the application's get-or-create race-safe via
-- ON CONFLICT DO NOTHING. A future multi-session feature drops this index.
CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_one_active_per_user
  ON dashboard_studio_meta_data.chat_sessions (user_id) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS dashboard_studio_meta_data.chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- THE transcript order authority: insertion order IS conversation order, whereas
  -- created_at can tie on same-millisecond writes or even step backwards on a clock
  -- adjustment, either of which flips a user/assistant pair on read. Gaps are
  -- expected and harmless (ON CONFLICT DO NOTHING consumes values).
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  session_id  UUID NOT NULL
              REFERENCES dashboard_studio_meta_data.chat_sessions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  -- Assistant turn kind, so a reloaded transcript shows a past error AS an error.
  -- NULL for user turns and for legacy rows.
  type        TEXT CHECK (type IN ('question', 'result', 'error')),
  -- The FULL dashboard JSON for 'result' turns — NEVER the s3:// URL. The agent's
  -- artifacts expire after a few months and a saved conversation outlives them, so
  -- they are fetched once at turn time and copied here. Budget ~5-50 KB per result
  -- turn; with the 100-row cap below that bounds a user at a few MB.
  result      JSONB,
  -- WHEN the turn entered the store (the application supplies it), not when the row
  -- was written: a turn buffered through a Postgres outage keeps its truthful time on
  -- replay. Display metadata only — ordering uses seq.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Client-minted idempotency id on USER turns, so a lost POST response is reconciled
  -- by id rather than by fragile content matching. NULL for assistant and legacy
  -- rows, and deliberately NOT unique — the row `id` already dedups a replayed
  -- INSERT; this is read-side match data only.
  client_turn_id TEXT
);

-- NOTE: chat_messages' own index is created at the END of section 2, NOT here. On a
-- database that already carries an earlier 002 the CREATE TABLE above is skipped, and
-- the index is on (session_id, seq) — a column that only section 2a is about to add.
-- Creating it here fails with "column seq does not exist" on exactly the tenants
-- section 2 exists to repair. Do not move it back up.


-- ---------------------------------------------------------------------------
-- 2. UPGRADES for a database that already carries an EARLIER 002
--    (all no-ops on a fresh install — section 1 just created the final shape)
-- ---------------------------------------------------------------------------

-- 2a. `seq` did not exist in the first 002 (2026-07-22); it arrived a day later.
--     Without it every read and every prune throws "column does not exist", and the
--     backend swallows that into the in-memory path: an install that looks applied
--     and persists nothing.
DO $$
DECLARE
  max_seq bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'dashboard_studio_meta_data'
                AND table_name   = 'chat_messages'
                AND column_name  = 'seq') THEN
    RETURN;
  END IF;

  RAISE NOTICE 'chat_messages.seq is missing (pre-2026-07-23 schema) — adding and backfilling';
  ALTER TABLE dashboard_studio_meta_data.chat_messages ADD COLUMN seq BIGINT;

  -- BEST EFFORT for rows that predate the column: created_at is the only order the
  -- old schema recorded, and its ties are the exact ambiguity seq was introduced to
  -- fix. Rows written from here on get true insertion order.
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
      FROM dashboard_studio_meta_data.chat_messages
  )
  UPDATE dashboard_studio_meta_data.chat_messages m
     SET seq = ordered.rn
    FROM ordered
   WHERE ordered.id = m.id;

  ALTER TABLE dashboard_studio_meta_data.chat_messages ALTER COLUMN seq SET NOT NULL;
  ALTER TABLE dashboard_studio_meta_data.chat_messages
    ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;

  -- The implicit sequence starts at 1, which would collide with every backfilled row.
  SELECT COALESCE(MAX(seq), 0) INTO max_seq
    FROM dashboard_studio_meta_data.chat_messages;
  PERFORM setval(
    pg_get_serial_sequence('dashboard_studio_meta_data.chat_messages', 'seq'),
    max_seq + 1, false);
END $$;

-- 2b. The first 002 indexed (session_id, created_at). Nothing reads chat_messages by
--     created_at — it is display metadata — so that index is dead weight once the seq
--     index exists.
DROP INDEX IF EXISTS dashboard_studio_meta_data.chat_messages_session_created_idx;

-- 2c. 003's executable half. 002 carried client_turn_id only INSIDE its
--     CREATE TABLE IF NOT EXISTS, so a database built by an earlier 002 never receives
--     the column from section 1 and would stay on the unsound content reconciliation.
ALTER TABLE dashboard_studio_meta_data.chat_messages
  ADD COLUMN IF NOT EXISTS client_turn_id TEXT;

-- 2d. The transcript index, deferred from section 1 so that `seq` is guaranteed to
--     exist on every path — freshly created above, or just added by 2a.
--
--     RETENTION: the application keeps the newest 100 turns per session and deletes
--     the rest inside the same transaction as every append, walking this index. The
--     table is bounded per user by construction — NO cleanup job is needed on your
--     side.
CREATE INDEX IF NOT EXISTS chat_messages_session_seq_idx
  ON dashboard_studio_meta_data.chat_messages (session_id, seq);


-- ---------------------------------------------------------------------------
-- 3. 003_add_turn_receipts.sql — durable per-turn receipts
-- ---------------------------------------------------------------------------
-- Deliberately OUTSIDE the capped transcript: absence from the newest-100 window is
-- NOT proof of non-delivery, because a delivered turn can be evicted by 100 newer
-- ones while the client still holds it. The client resolves that by looking the id up
-- here (GET /api/agent/turn-status). Rows are tiny — id plus status — and pruned by
-- recency (7 days) inside the append transaction, so this never grows like the
-- transcript does.
--
-- Created directly with the per-user key from 004; section 4 repairs a database that
-- already has the older 003 shape.
CREATE TABLE IF NOT EXISTS dashboard_studio_meta_data.chat_turn_receipts (
  client_turn_id TEXT NOT NULL,
  user_id        UUID NOT NULL,
  session_id     UUID,
  -- 'received' the moment the USER turn is persisted, before the multi-second agent
  -- call; 'answered' once the assistant/error turn for that same id lands. That pair
  -- is also what the server-side single-active-turn guard reads, which is why it is
  -- an exact user-to-reply match rather than "any later assistant turn".
  status         TEXT NOT NULL CHECK (status IN ('received', 'answered')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, client_turn_id)
);

-- Serves the recency prune above and keeps the turn-status lookup cheap.
CREATE INDEX IF NOT EXISTS chat_turn_receipts_user_updated_idx
  ON dashboard_studio_meta_data.chat_turn_receipts (user_id, updated_at);


-- ---------------------------------------------------------------------------
-- 4. 004_receipt_key_per_user.sql — scope the receipt key to the user
-- ---------------------------------------------------------------------------
-- 003 keyed this table GLOBALLY on client_turn_id, while every check that reads it is
-- scoped by user_id — and the id is a client-minted arbitrary string. If user B sends
-- a turn under an id user A already holds:
--
--   * B's duplicate check (scoped to B) finds nothing and admits the turn;
--   * B's user message row is written;
--   * B's receipt INSERT hits the GLOBAL key and does nothing, so B has no receipt at
--     all and B's turn is unguarded;
--   * B's reply then upgrades the matching row — which is A's — to 'answered',
--     releasing A's single-active-turn guard while A's turn is still running.
--
-- The application REQUIRES the (user_id, client_turn_id) key: its probe treats a
-- globally-keyed table as no receipts table at all, and disables the guard rather
-- than run a cross-user hazard. So this section is not optional polish.
--
-- Uniqueness is not weakened for anyone: the old key was unique on client_turn_id
-- alone, so no existing pair can collide and no rows need cleaning up first.
--
-- (Differs from standalone 004 in one way: that file returns early when the table is
-- absent, since it could legitimately run before 003. Here section 3 has guaranteed
-- the table exists, so "no primary key at all" is a defect to repair, not to skip.)
DO $$
DECLARE
  pk_name    text;
  pk_columns text[];
BEGIN
  SELECT c.constraint_name,
         array_agg(k.column_name::text ORDER BY k.column_name::text)
    INTO pk_name, pk_columns
    FROM information_schema.table_constraints c
    JOIN information_schema.key_column_usage k
      ON k.constraint_name   = c.constraint_name
     AND k.constraint_schema = c.constraint_schema
   WHERE c.constraint_schema = 'dashboard_studio_meta_data'
     AND c.table_name        = 'chat_turn_receipts'
     AND c.constraint_type   = 'PRIMARY KEY'
   GROUP BY c.constraint_name;

  IF pk_columns = ARRAY['client_turn_id', 'user_id'] THEN
    RETURN;
  END IF;

  RAISE NOTICE 'chat_turn_receipts primary key is % — re-keying to (user_id, client_turn_id)',
    COALESCE(pk_columns::text, 'absent');

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE dashboard_studio_meta_data.chat_turn_receipts DROP CONSTRAINT %I',
                   pk_name);
  END IF;
  ALTER TABLE dashboard_studio_meta_data.chat_turn_receipts
    ADD PRIMARY KEY (user_id, client_turn_id);
END $$;


-- ---------------------------------------------------------------------------
-- 5. GRANTS — optional, driven by chat_migration.app_role
-- ---------------------------------------------------------------------------
-- This is the most likely way a SUCCESSFUL apply still does nothing. You are probably
-- running as an owner or superuser, but the application connects as whatever role is
-- in the customer's userDbUrl. If that role cannot write these tables, the backend's
-- probe sees them, every write then fails, and the failure is swallowed into the
-- in-memory path — chat keeps working and no error surfaces anywhere.
DO $$
DECLARE
  app_role text := NULLIF(btrim(COALESCE(current_setting('chat_migration.app_role', true), '')), '');
  seq_name text;
BEGIN
  IF app_role IS NULL THEN
    RAISE NOTICE 'GRANTS SKIPPED — chat_migration.app_role is not set. That is correct ONLY if the application connects as "%", the role running this script.', current_user;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'chat_migration.app_role = "%" does not exist in this database', app_role;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA dashboard_studio_meta_data TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON '
                 'dashboard_studio_meta_data.chat_sessions, '
                 'dashboard_studio_meta_data.chat_messages, '
                 'dashboard_studio_meta_data.chat_turn_receipts TO %I', app_role);

  -- An identity column does not need its sequence granted the way a serial does;
  -- granting it anyway costs nothing and removes the question.
  seq_name := pg_get_serial_sequence('dashboard_studio_meta_data.chat_messages', 'seq');
  IF seq_name IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I', seq_name, app_role);
  END IF;

  RAISE NOTICE 'granted chat table DML to "%"', app_role;
END $$;


-- ---------------------------------------------------------------------------
-- 6. VERIFY — raises, so a partial apply rolls back instead of committing
-- ---------------------------------------------------------------------------
-- Every check below is something the backend's probe or its queries actually require.
-- A miss here means silent degradation, never a visible error, which is exactly why
-- this runs before COMMIT rather than being left to the operator.
DO $$
DECLARE
  problems text[] := '{}';
  pk_columns text[];
BEGIN
  IF to_regclass('dashboard_studio_meta_data.chat_sessions') IS NULL THEN
    problems := problems || 'chat_sessions table missing';
  END IF;
  IF to_regclass('dashboard_studio_meta_data.chat_messages') IS NULL THEN
    problems := problems || 'chat_messages table missing';
  END IF;
  IF to_regclass('dashboard_studio_meta_data.chat_turn_receipts') IS NULL THEN
    problems := problems || 'chat_turn_receipts table missing';
  END IF;
  IF to_regclass('dashboard_studio_meta_data.chat_sessions_one_active_per_user') IS NULL THEN
    problems := problems || 'chat_sessions_one_active_per_user index missing';
  END IF;
  IF to_regclass('dashboard_studio_meta_data.chat_messages_session_seq_idx') IS NULL THEN
    problems := problems || 'chat_messages_session_seq_idx missing';
  END IF;
  IF to_regclass('dashboard_studio_meta_data.chat_turn_receipts_user_updated_idx') IS NULL THEN
    problems := problems || 'chat_turn_receipts_user_updated_idx missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'dashboard_studio_meta_data'
                    AND table_name = 'chat_messages'
                    AND column_name = 'seq'
                    AND is_identity = 'YES') THEN
    problems := problems || 'chat_messages.seq missing or not an identity column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'dashboard_studio_meta_data'
                    AND table_name = 'chat_messages'
                    AND column_name = 'client_turn_id') THEN
    problems := problems || 'chat_messages.client_turn_id missing';
  END IF;

  SELECT array_agg(k.column_name::text ORDER BY k.column_name::text)
    INTO pk_columns
    FROM information_schema.table_constraints c
    JOIN information_schema.key_column_usage k
      ON k.constraint_name   = c.constraint_name
     AND k.constraint_schema = c.constraint_schema
   WHERE c.constraint_schema = 'dashboard_studio_meta_data'
     AND c.table_name        = 'chat_turn_receipts'
     AND c.constraint_type   = 'PRIMARY KEY';
  IF pk_columns IS DISTINCT FROM ARRAY['client_turn_id', 'user_id'] THEN
    problems := problems ||
      format('chat_turn_receipts primary key is %s, expected (user_id, client_turn_id)',
             COALESCE(pk_columns::text, 'absent'));
  END IF;

  IF array_length(problems, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFICATION FAILED — nothing has been committed: %',
      array_to_string(problems, '; ');
  END IF;

  RAISE NOTICE 'verification passed — transcript, turn ids and receipts are all present';
END $$;

COMMIT;


-- ---------------------------------------------------------------------------
-- 7. REPORT — what the application will now see
-- ---------------------------------------------------------------------------
-- Runs after COMMIT and only reads, so it is also the standalone health check: run
-- section 7 on its own any time to inspect a tenant without touching it.
SELECT check_name, status FROM (
  SELECT 1 AS ord, 'chat_sessions table' AS check_name,
         CASE WHEN to_regclass('dashboard_studio_meta_data.chat_sessions') IS NOT NULL
              THEN 'OK' ELSE 'MISSING' END AS status
  UNION ALL SELECT 2, 'chat_messages table',
         CASE WHEN to_regclass('dashboard_studio_meta_data.chat_messages') IS NOT NULL
              THEN 'OK' ELSE 'MISSING' END
  UNION ALL SELECT 3, 'chat_turn_receipts table',
         CASE WHEN to_regclass('dashboard_studio_meta_data.chat_turn_receipts') IS NOT NULL
              THEN 'OK' ELSE 'MISSING' END
  UNION ALL SELECT 4, 'history persists (probe: tables)',
         CASE WHEN to_regclass('dashboard_studio_meta_data.chat_sessions') IS NOT NULL
               AND to_regclass('dashboard_studio_meta_data.chat_messages') IS NOT NULL
              THEN 'ON — GET /api/agent/session returns persisted: true'
              ELSE 'OFF — history stays in process memory' END
  UNION ALL SELECT 5, 'turn ids (probe: clientTurnId)',
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'dashboard_studio_meta_data'
                              AND table_name = 'chat_messages'
                              AND column_name = 'client_turn_id')
              THEN 'ON — supports_turn_ids: true'
              ELSE 'OFF — client falls back to content matching' END
  UNION ALL SELECT 6, 'turn guard + receipts (probe: receipts)',
         CASE WHEN (SELECT array_agg(k.column_name::text ORDER BY k.column_name::text)
                      FROM information_schema.table_constraints c
                      JOIN information_schema.key_column_usage k
                        ON k.constraint_name   = c.constraint_name
                       AND k.constraint_schema = c.constraint_schema
                     WHERE c.constraint_schema = 'dashboard_studio_meta_data'
                       AND c.table_name        = 'chat_turn_receipts'
                       AND c.constraint_type   = 'PRIMARY KEY')
                   = ARRAY['client_turn_id', 'user_id']
              THEN 'ON — durable turn-status and the server-side guard'
              ELSE 'OFF — key is not (user_id, client_turn_id)' END
) r ORDER BY ord;

-- AFTERWARDS, ON THE APPLICATION SIDE
--   * The backend caches its schema probe per connection pool for 60 seconds, so
--     allow up to a minute (or a reconnect) before the change is visible.
--   * GET /api/agent/session should return persisted: true and supports_turn_ids: true.
--   * These backend log lines should stop appearing for this tenant:
--       "chat_sessions table does not exist in dashboard_studio_meta_data schema"
--       "chat_turn_receipts is keyed globally; apply 004 to enable the turn guard"
--       "chat schema probe failed; degrading to in-memory history"
--     The last one means the probe could not run at all — connectivity or privileges,
--     not missing DDL.

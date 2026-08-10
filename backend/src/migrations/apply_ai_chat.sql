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
--   login — as a role that may CREATE in the `dashboard_studio_meta_data` schema AND
--   OWNS the three chat tables wherever they already exist. Ownership is not optional
--   on a database that already carries an earlier 002: every repair below is an ALTER,
--   and ALTER checks ownership. Section 0 says so up front rather than failing halfway.
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
--   psql "postgresql://USER:PASS@HOST:5432/DB" -f apply_ai_chat.sql
--
--   Run it under psql: the `\set ON_ERROR_STOP` below is the one line in this file that
--   is not plain SQL, and another client reports it as a syntax error. Under psql it
--   removes a flag you can forget — without it psql turns the COMMIT of an aborted
--   transaction into a ROLLBACK and carries on past the failure.
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
--   tables; `users` is read, never modified. On an up-to-date database nothing here
--   takes a lock heavier than the catalog lookups that prove there is nothing to do.
--
--   IT ALSO CHANGES RUNTIME BEHAVIOUR ON FAILURE. Once the receipts table carries the
--   (user_id, client_turn_id) key, the backend stops silently buffering a user turn to
--   memory when the settings database misbehaves and refuses the turn with 503 instead.
--   That is the deliberate trade — no turn persisted without an agent dispatched to
--   answer it — but it arms the moment this commits, so prefer a quiet window over live
--   chat traffic.

\set ON_ERROR_STOP on

BEGIN;

-- The backfill in 2a rewrites chat_messages, which a role-level statement_timeout (routine
-- on hosted Postgres) would kill mid-apply, losing everything. lock_timeout is the other
-- half: if this transaction meets a live chat write it gives way rather than winning and
-- blocking the application. Both are LOCAL — nothing outside this transaction changes.
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '3s';

-- SET chat_migration.app_role = 'dashboard_settings';   -- <- uncomment + edit for grants


-- ---------------------------------------------------------------------------
-- 0. PREFLIGHT — fail before any DDL, not after
-- ---------------------------------------------------------------------------
-- Everything here reads pg_catalog, NOT information_schema, which is privilege-filtered:
-- its `columns` view shows only columns the current role holds some privilege on. A role
-- holding exactly the precondition above — CREATE on the schema, nothing on `users`,
-- which another role owns — sees ZERO rows for users.id and gets told this is the wrong
-- database, with the type check that matters never actually run. pg_catalog reports what
-- exists rather than what you may touch, so the answer does not depend on your grants.
DO $$
DECLARE
  users_id_type text;
  not_owned     text;
BEGIN
  IF to_regnamespace('dashboard_studio_meta_data') IS NULL THEN
    RAISE EXCEPTION
      'Schema dashboard_studio_meta_data not found. This is not a tenant settings database — check that you connected with the userDbUrl and not the iotDbUrl.';
  END IF;

  -- Section 6 builds its check list as a pg_temp view, which needs TEMPORARY on the
  -- DATABASE — not implied by owning the schema, and routinely revoked from PUBLIC.
  -- Unchecked, every table, index, repair and GRANT below runs and then rolls back on
  -- "permission denied to create temporary tables", which names nothing about chat.
  IF NOT has_database_privilege(current_user, current_database(), 'TEMP') THEN
    RAISE EXCEPTION
      'TEMPORARY is not granted on database "%" to "%", and section 6 builds its check list as a pg_temp view. Run: GRANT TEMPORARY ON DATABASE "%" TO "%";',
      current_database(), current_user, current_database(), current_user;
  END IF;

  -- The re-run promise is only good for a role that owns what is already there: every
  -- repair below is an ALTER, and ALTER checks ownership. Fail here, with the remedy,
  -- rather than several statements into the script.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO not_owned
    FROM pg_class c
   WHERE c.oid IN (to_regclass('dashboard_studio_meta_data.chat_sessions'),
                   to_regclass('dashboard_studio_meta_data.chat_messages'),
                   to_regclass('dashboard_studio_meta_data.chat_turn_receipts'))
     AND NOT pg_has_role(c.relowner, 'USAGE');

  IF not_owned IS NOT NULL THEN
    RAISE EXCEPTION
      'Chat table(s) already exist and are owned by another role: %. CREATE on the schema is not enough to upgrade them — re-run as the owner, or ALTER TABLE dashboard_studio_meta_data.<table> OWNER TO "%".',
      not_owned, current_user;
  END IF;

  -- typbasetype unwraps a DOMAIN: format_type() reports the domain's own name, so an id
  -- on a uuid domain would be refused below as the wrong type (data_type did not do that).
  SELECT format_type(COALESCE(NULLIF(t.typbasetype, 0), a.atttypid), a.atttypmod)
    INTO users_id_type
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = to_regclass('dashboard_studio_meta_data.users')
     AND a.attname  = 'id'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

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
--
-- Guarded on to_regclass rather than written as CREATE UNIQUE INDEX IF NOT EXISTS: that
-- form still takes a ShareLock on chat_sessions when the index is already there, held to
-- COMMIT. Paired with 2c it gives this transaction chat_sessions-then-chat_messages,
-- which is the inverse of the application's append order and deadlocks a live chat write
-- on the re-run this file advertises as a no-op. to_regclass takes no lock at all.
DO $$
BEGIN
  IF to_regclass('dashboard_studio_meta_data.chat_sessions_one_active_per_user') IS NULL THEN
    CREATE UNIQUE INDEX chat_sessions_one_active_per_user
      ON dashboard_studio_meta_data.chat_sessions (user_id) WHERE is_deleted = FALSE;
  END IF;
END $$;

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
--
--     The guard is "seq is an IDENTITY column", not "seq exists". Someone who reached
--     for the obvious partial fix — `ADD COLUMN seq BIGINT`, or BIGSERIAL, neither of
--     which is an identity column — satisfies the weaker test but still fails section
--     6, so a guard on existence alone detects that tenant as broken and then refuses
--     to repair it, on this run and every future one.
DO $$
DECLARE
  old_seq text;
  seq_type text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = to_regclass('dashboard_studio_meta_data.chat_messages')
                AND attname = 'seq' AND attidentity <> '' AND NOT attisdropped) THEN
    RETURN;
  END IF;

  -- A non-integer `seq` otherwise aborts the backfill below with "COALESCE types text
  -- and integer cannot be matched", which names neither the column nor the cause.
  SELECT format_type(atttypid, atttypmod) INTO seq_type FROM pg_attribute
   WHERE attrelid = to_regclass('dashboard_studio_meta_data.chat_messages')
     AND attname = 'seq' AND NOT attisdropped;
  IF seq_type IS NOT NULL AND seq_type NOT IN ('smallint', 'integer', 'bigint') THEN
    RAISE EXCEPTION 'chat_messages.seq already exists with type "%". It is the transcript order authority and has to be an integer type; drop or correct that column, then re-run.', seq_type;
  END IF;

  RAISE NOTICE 'chat_messages.seq is missing or is not an identity column — adding and backfilling';
  ALTER TABLE dashboard_studio_meta_data.chat_messages ADD COLUMN IF NOT EXISTS seq BIGINT;

  -- ADD GENERATED refuses a column that carries a default, so drop whatever is there
  -- UNCONDITIONALLY. Not only BIGSERIAL leaves one: `ADD COLUMN seq BIGINT DEFAULT 0` is
  -- as likely a hand repair, and a sequence attached without OWNED BY is invisible to
  -- pg_get_serial_sequence — both survive a drop conditioned on that lookup and abort the
  -- whole apply, forever. DROP DEFAULT on a column that has none is a no-op.
  ALTER TABLE dashboard_studio_meta_data.chat_messages ALTER COLUMN seq DROP DEFAULT;

  -- A hand-applied BIGSERIAL also leaves the sequence itself behind. Attached to the
  -- column it would make pg_get_serial_sequence ambiguous once the identity one exists
  -- beside it — which is what section 5 grants and 2e repositions. What resolves it is
  -- the OWNED BY dependency, not the default, so it is still found here.
  old_seq := pg_get_serial_sequence('dashboard_studio_meta_data.chat_messages', 'seq');
  IF old_seq IS NOT NULL THEN
    EXECUTE format('DROP SEQUENCE %s', old_seq);
  END IF;

  -- BEST EFFORT for rows that predate the column: created_at is the only order the
  -- old schema recorded, and its ties are the exact ambiguity seq was introduced to
  -- fix. Rows written from here on get true insertion order. Numbers a hand-repair
  -- already assigned are kept — only the gaps are filled, and past the current maximum.
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id)
             + COALESCE((SELECT MAX(seq) FROM dashboard_studio_meta_data.chat_messages), 0) AS rn
      FROM dashboard_studio_meta_data.chat_messages
     WHERE seq IS NULL
  )
  UPDATE dashboard_studio_meta_data.chat_messages m
     SET seq = ordered.rn
    FROM ordered
   WHERE ordered.id = m.id;

  ALTER TABLE dashboard_studio_meta_data.chat_messages ALTER COLUMN seq SET NOT NULL;
  ALTER TABLE dashboard_studio_meta_data.chat_messages
    ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;
END $$;

-- 2b. The first 002 indexed (session_id, created_at). Nothing reads chat_messages by
--     created_at — it is display metadata — so that index is dead weight once the seq
--     index exists.
DROP INDEX IF EXISTS dashboard_studio_meta_data.chat_messages_session_created_idx;

-- 2c. 003's executable half. 002 carried client_turn_id only INSIDE its
--     CREATE TABLE IF NOT EXISTS, so a database built by an earlier 002 never receives
--     the column from section 1 and would stay on the unsound content reconciliation.
--
--     Guarded for the same reason as the index in section 1, only worse: ALTER TABLE
--     ... ADD COLUMN IF NOT EXISTS takes an AccessExclusiveLock on chat_messages even
--     when the column is already there and it does nothing, and holds it to COMMIT.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('dashboard_studio_meta_data.chat_messages')
                    AND attname = 'client_turn_id' AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE dashboard_studio_meta_data.chat_messages ADD COLUMN client_turn_id TEXT;
  END IF;
END $$;

-- 2d. The transcript index, deferred from section 1 so that `seq` is guaranteed to
--     exist on every path — freshly created above, or just added by 2a.
--
--     RETENTION: the application keeps the newest 100 turns per session and deletes
--     the rest inside the same transaction as every append, walking this index. The
--     table is bounded per user by construction — NO cleanup job is needed on your
--     side.
DO $$
BEGIN
  IF to_regclass('dashboard_studio_meta_data.chat_messages_session_seq_idx') IS NULL THEN
    CREATE INDEX chat_messages_session_seq_idx
      ON dashboard_studio_meta_data.chat_messages (session_id, seq);
  END IF;
END $$;

-- 2e. Position the identity sequence past MAX(seq). 2a's backfill needs it, and so does
--     a tenant that was repaired by hand without it: `seq` carries no unique constraint,
--     so a sequence sitting behind the data hands out numbers that already exist, in
--     silence — which is the one guarantee seq is here to provide, and what
--     pruneOldTurns' newest-100 boundary walks.
--
--     The position is READ from the sequence relation, never probed with nextval(). A
--     probe consumes a value, and on the no-op path nothing here holds a lock that would
--     stop a concurrent append taking the next one — so a setval computed from the probe
--     rewinds over that append's number and hands it out a second time. Reading also
--     means the advertised no-op re-run stops writing the sequence at all: this only
--     ever moves it FORWARD, and only when it is genuinely behind the data, so a table
--     the prune has trimmed (MAX(seq) far below the sequence) is left alone.
--     (pg_sequence_last_value() is no use here — it returns NULL when is_called is
--     false, which is exactly the state this block leaves behind.)
DO $$
DECLARE
  seq_name text := pg_get_serial_sequence('dashboard_studio_meta_data.chat_messages', 'seq');
  max_seq  bigint;
  last_val bigint;
  called   boolean;
BEGIN
  SELECT COALESCE(MAX(seq), 0) INTO max_seq FROM dashboard_studio_meta_data.chat_messages;
  EXECUTE format('SELECT last_value, is_called FROM %s', seq_name) INTO last_val, called;
  IF (CASE WHEN called THEN last_val + 1 ELSE last_val END) <= max_seq THEN
    PERFORM setval(seq_name, max_seq + 1, false);
  END IF;
END $$;


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

-- Serves the recency prune above and keeps the turn-status lookup cheap. Guarded, not
-- IF NOT EXISTS, for the lock reason given in section 1.
DO $$
BEGIN
  IF to_regclass('dashboard_studio_meta_data.chat_turn_receipts_user_updated_idx') IS NULL THEN
    CREATE INDEX chat_turn_receipts_user_updated_idx
      ON dashboard_studio_meta_data.chat_turn_receipts (user_id, updated_at);
  END IF;
END $$;


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
-- running as an owner or superuser, but the application connects as whatever role is in
-- the customer's userDbUrl — and what that role cannot see, it reports as absent, because
-- the probe reads information_schema and information_schema is privilege-filtered.
--
--   * NO grants at all. The probe does not see the tables. The backend logs
--     "chat_sessions table does not exist in dashboard_studio_meta_data schema" and keeps
--     history in memory, so a correct apply looks exactly like one that never happened —
--     and re-running this script produces a clean report and changes nothing.
--   * PARTIAL grants. The probe sees the tables, every write then fails, and the failure
--     is swallowed into the in-memory path: chat keeps working, no error surfaces.
--     SELECT-only is the sharp edge — information_schema.table_constraints filters on
--     WRITE privileges, so the receipts primary key reads as absent, the single-active-turn
--     guard is disabled, and none of the three log lines at the end of this file fires.
--
-- Row 10 of the report answers both — but only if chat_migration.app_role is set. Left
-- unset it checks the role you are connected as, which is the one role you already know
-- can write. Set it (below, or via PGOPTIONS) whenever you want that row to say anything
-- about the application.
DO $$
DECLARE
  app_role text := NULLIF(btrim(COALESCE(current_setting('chat_migration.app_role', true), '')), '');
  seq_name text;
BEGIN
  IF app_role IS NULL THEN
    -- WARNING, not NOTICE: client_min_messages is 'warning' in plenty of setups (set on
    -- the database, on the role, or via PGOPTIONS) and every NOTICE this script raises
    -- then vanishes, leaving an all-OK report as the only output.
    RAISE WARNING 'GRANTS SKIPPED — chat_migration.app_role is not set. That is correct ONLY if the application connects as "%", the role running this script.', current_user;
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

  -- GRANT does not FAIL when the granting role has no right to grant — it emits
  -- "WARNING: no privileges were granted" and carries on, which the NOTICE below would
  -- then contradict. A role with CREATE on the schema but not owning it is exactly the
  -- precondition this file states, and it cannot grant USAGE on that schema. Assert the
  -- outcome rather than trust the statement.
  IF NOT has_schema_privilege(app_role, 'dashboard_studio_meta_data', 'USAGE') THEN
    RAISE EXCEPTION
      'GRANT USAGE ON SCHEMA to "%" did not take effect — you do not own dashboard_studio_meta_data (look for "no privileges were granted" just above). Re-run as the schema owner or a superuser.', app_role;
  END IF;
  IF NOT has_table_privilege(app_role, 'dashboard_studio_meta_data.chat_messages', 'INSERT') THEN
    RAISE EXCEPTION
      'GRANT on the chat tables to "%" did not take effect — you do not own them (look for "no privileges were granted" just above). Re-run as the table owner or a superuser.', app_role;
  END IF;

  RAISE NOTICE 'granted chat table DML to "%"', app_role;
END $$;


-- ---------------------------------------------------------------------------
-- 6. VERIFY — raises, so a partial apply rolls back instead of committing
-- ---------------------------------------------------------------------------
-- Every row below is something the backend's probe or its queries actually require. A
-- miss means silent degradation, never a visible error, which is exactly why this runs
-- before COMMIT rather than being left to the operator.
--
-- The list exists ONCE, as a view: the report an operator reads and the verdict that
-- decides COMMIT are the same rows, so neither can certify a shape the other rejects.
-- Add a check here and both pick it up. The view is session-local (pg_temp) and goes
-- away when psql exits — nothing is created in the tenant's schema.
--
-- Everything it reads is a pg_catalog lookup: not privilege-filtered the way
-- information_schema is, no locks, and valid on a tenant that has none of these objects.
-- So the SELECT below, on its own without the CREATE line, is the read-only health check
-- for any tenant — that is the query to keep, not section 7.
CREATE OR REPLACE VIEW pg_temp.chat_apply_report AS
WITH s AS (
  SELECT to_regnamespace('dashboard_studio_meta_data')                                 AS ns,
         to_regclass('dashboard_studio_meta_data.chat_sessions')                       AS t_sessions,
         to_regclass('dashboard_studio_meta_data.chat_messages')                       AS t_messages,
         to_regclass('dashboard_studio_meta_data.chat_turn_receipts')                  AS t_receipts,
         to_regclass('dashboard_studio_meta_data.chat_sessions_one_active_per_user')   AS i_active,
         to_regclass('dashboard_studio_meta_data.chat_messages_session_seq_idx')       AS i_seq,
         to_regclass('dashboard_studio_meta_data.chat_turn_receipts_user_updated_idx') AS i_recent,
         COALESCE(NULLIF(btrim(COALESCE(current_setting('chat_migration.app_role', true), '')), ''),
                  current_user::text)                                                  AS app_role
), f AS (
  SELECT s.*,
         EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = s.t_messages AND a.attname = 'seq'
                    AND a.attidentity <> '' AND NOT a.attisdropped)                    AS seq_identity,
         EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = s.t_messages AND a.attname = 'client_turn_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)                           AS has_turn_id,
         (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
           WHERE c.conrelid = s.t_receipts AND c.contype = 'p')                        AS pk_columns,
         -- Shape, not just name: a same-named index that is not unique satisfies
         -- section 1's to_regclass guard, so nothing is created, and then ON CONFLICT
         -- DO NOTHING quietly stops de-duplicating sessions instead of failing.
         (SELECT x.indisunique AND pg_get_expr(x.indpred, x.indrelid) = '(is_deleted = false)'
            FROM pg_index x WHERE x.indexrelid = s.i_active)                           AS active_shape,
         -- COALESCE to false per table, not around the aggregate: bool_and SKIPS nulls,
         -- so a missing table would otherwise let the remaining two vote it OK.
         (SELECT bool_and(COALESCE(has_table_privilege(s.app_role, t, p), false))
            FROM unnest(ARRAY[s.t_sessions, s.t_messages, s.t_receipts]) AS t,
                 unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p)
           AND COALESCE(has_schema_privilege(s.app_role, s.ns, 'USAGE'), false)        AS app_can_write
    FROM s
)
SELECT ord, check_name, status, detail FROM f, LATERAL (VALUES
  ( 1, 'chat_sessions table',
       CASE WHEN f.t_sessions IS NOT NULL THEN 'OK' ELSE 'MISSING' END, ''),
  ( 2, 'chat_messages table',
       CASE WHEN f.t_messages IS NOT NULL THEN 'OK' ELSE 'MISSING' END, ''),
  ( 3, 'chat_turn_receipts table',
       CASE WHEN f.t_receipts IS NOT NULL THEN 'OK' ELSE 'MISSING' END, ''),
  ( 4, 'chat_messages.seq identity column',
       CASE WHEN f.seq_identity THEN 'OK' ELSE 'MISSING' END,
       'the transcript order authority; without it every read and every prune throws'),
  ( 5, 'chat_messages.client_turn_id column',
       CASE WHEN f.has_turn_id THEN 'OK' ELSE 'MISSING' END, ''),
  ( 6, 'chat_sessions_one_active_per_user index',
       CASE WHEN COALESCE(f.active_shape, false) THEN 'OK' ELSE 'MISSING' END,
       CASE WHEN f.i_active IS NULL OR COALESCE(f.active_shape, false) THEN ''
            ELSE 'an index of that name exists but is not UNIQUE (user_id) WHERE is_deleted = FALSE'
                 || ' — drop it and re-run' END),
  ( 7, 'chat_messages_session_seq_idx index',
       CASE WHEN f.i_seq IS NOT NULL THEN 'OK' ELSE 'MISSING' END, ''),
  ( 8, 'chat_turn_receipts_user_updated_idx index',
       CASE WHEN f.i_recent IS NOT NULL THEN 'OK' ELSE 'MISSING' END, ''),
  ( 9, 'chat_turn_receipts primary key',
       CASE WHEN f.pk_columns = ARRAY['client_turn_id', 'user_id'] THEN 'OK' ELSE 'WRONG' END,
       CASE WHEN f.pk_columns = ARRAY['client_turn_id', 'user_id'] THEN ''
            ELSE 'found ' || COALESCE(f.pk_columns::text, 'no primary key')
                 || ', expected (user_id, client_turn_id)' END),
  (10, 'app role can write the chat tables',
       CASE WHEN f.app_can_write THEN 'OK' ELSE 'MISSING' END,
       'checked for "' || f.app_role || '" — chat_migration.app_role, or the connected role when unset'),
  (11, 'history persists (probe: tables)',
       CASE WHEN f.t_sessions IS NOT NULL AND f.t_messages IS NOT NULL AND f.seq_identity
            THEN 'ON' ELSE 'OFF' END,
       'ON = GET /api/agent/session returns persisted: true; OFF = history stays in process memory'),
  (12, 'turn ids (probe: clientTurnId)',
       CASE WHEN f.has_turn_id THEN 'ON' ELSE 'OFF' END,
       'ON = supports_turn_ids: true; OFF = the client falls back to content matching'),
  (13, 'turn guard + receipts (probe: receipts)',
       CASE WHEN f.pk_columns = ARRAY['client_turn_id', 'user_id'] THEN 'ON' ELSE 'OFF' END,
       'ON = durable turn-status and the server-side single-active-turn guard')
) AS v(ord, check_name, status, detail);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(check_name || ' — ' || status ||
                    CASE WHEN detail = '' THEN '' ELSE ' (' || detail || ')' END,
                    '; ' ORDER BY ord)
    INTO bad
    FROM pg_temp.chat_apply_report
   WHERE status NOT IN ('OK', 'ON');

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFICATION FAILED — nothing has been committed: %', bad;
  END IF;

  RAISE NOTICE 'verification passed — transcript, turn ids, receipts and grants are all present';
END $$;


-- ---------------------------------------------------------------------------
-- 7. REPORT — what the application will now see
-- ---------------------------------------------------------------------------
-- The rows section 6 just enforced, printed INSIDE the transaction that built the view.
-- pg_temp belongs to one server connection, and a tenant userDbUrl usually points at a
-- transaction-mode pooler, which is free to route the statement after COMMIT to a
-- different backend: read there, this fails with `relation "pg_temp.chat_apply_report"
-- does not exist` and ends a completely successful apply on a red error and exit 3.
-- Reading it here cannot disagree with the verdict either — section 6 has already
-- raised on any non-OK row, so these rows print only when every one of them passed.
SELECT check_name, status, detail FROM pg_temp.chat_apply_report ORDER BY ord;

COMMIT;

-- AFTERWARDS, ON THE APPLICATION SIDE
--   * The backend caches its schema probe per connection pool for 60 seconds, so
--     allow up to a minute (or a reconnect) before the change is visible.
--   * GET /api/agent/session should return persisted: true and supports_turn_ids: true.
--   * These backend log lines should stop appearing for this tenant:
--       "chat_sessions table does not exist in dashboard_studio_meta_data schema"
--       "chat_turn_receipts is keyed globally; apply 004 to enable the turn guard"
--       "chat schema probe failed; degrading to in-memory history"
--     The last one means the probe could not run at all — connectivity or privileges,
--     not missing DDL. If the FIRST one persists after a clean apply, do not re-run this
--     script: it says "the app role cannot SEE the tables", which is what a missing GRANT
--     looks like through privilege-filtered information_schema. Re-run section 6's SELECT
--     with chat_migration.app_role set to the role in the userDbUrl and read row 10.

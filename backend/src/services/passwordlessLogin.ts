import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { logger } from '../utils/logger.js';
import { CustomError } from '../middleware/errorHandler.js';

/** The user row shape this module reads. Structural so the module does not import
 *  database.js, which drags in sqlSelectGuard's createRequire — unloadable under
 *  this repo's ts-jest ESM setup, and the reason none of this was testable
 *  in place. */
export interface LoginUserRow {
  id: string;
  email: string;
  raw_user_meta_data?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export interface LoginParams {
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  iotDbUrl: string;
  userDbUrl: string;
  demo: boolean;
}

export interface LoginIdentity {
  user: LoginUserRow;
  isNewUser: boolean;
  /** The role the account ACTUALLY holds. For a demo login on a pre-existing row
   *  this is the STORED role, not the requested one, so a demo sign-in can never
   *  hand itself more privilege than the account already has. */
  effectiveRole: 'admin' | 'editor' | 'viewer';
  /** Present only when this login may later delete the row — see
   *  services/demoUserCleanup.ts. */
  demoCleanupToken: string | undefined;
}

/**
 * Resolve (and if necessary create) the user this passwordless login is for, in
 * ONE transaction, serialized per email address (review !62 round 12, Critical 1).
 *
 * This used to run as a series of autocommit statements, so two logins for the
 * same address interleaved freely and a demo cleanup marker could be written
 * AFTER a real login had already adopted the row:
 *
 *   demo A inserts the row (no marker yet) -> normal B finds it and finishes its
 *   role/metadata update -> A writes its marker -> A's cleanup matches and
 *   deletes the user B is now signed in as.
 *
 * The reverse was no better: the cleanup could delete the row between B's SELECT
 * and its unchecked UPDATE, leaving B holding a JWT for a user that no longer
 * exists.
 *
 * Everything that decides WHO this login is — get-or-create, the role and
 * metadata writes, the marker, and therefore the JWT — happens inside the
 * transaction. The advisory lock covers the CREATE path, where there is no row to
 * lock yet; SELECT … FOR UPDATE covers the rest and is what serializes a login
 * against a concurrent cleanup, since the cleanup takes the same row lock before
 * it deletes anything.
 */
export async function resolveLoginIdentity(
  client: PoolClient,
  params: LoginParams,
): Promise<LoginIdentity> {
  const { email, role, iotDbUrl, userDbUrl, demo } = params;

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:${email}`]);

    const found = await client.query(
      'SELECT * FROM dashboard_studio_meta_data.users WHERE email = $1 FOR UPDATE',
      [email],
    );

    let identity: LoginIdentity;
    if (found.rows.length === 0) {
      identity = await createUser(client, params);
    } else if (demo) {
      identity = await adoptExistingAsDemo(client, found.rows[0] as LoginUserRow, role);
    } else {
      identity = await adoptExistingAsUser(
        client, found.rows[0] as LoginUserRow, role, iotDbUrl, userDbUrl,
      );
    }

    await client.query('COMMIT');
    return identity;
  } catch (error) {
    // An open transaction must never go back to the pool: node-pg does not roll
    // one back on release, so the next borrower would inherit it.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function createUser(client: PoolClient, params: LoginParams): Promise<LoginIdentity> {
  const { email, role, iotDbUrl, userDbUrl, demo } = params;
  logger.info('Creating new user for passwordless auth', { email, role });

  // The marker is written AT CREATION, in the same statement. Minting it in a
  // later UPDATE is exactly what left a window for another login to adopt the row
  // first and then be deleted by this one's cleanup.
  const demoCleanupToken = demo ? randomUUID() : undefined;
  const inserted = await client.query(
    `INSERT INTO dashboard_studio_meta_data.users
       (email, email_confirmed_at, is_super_admin, raw_user_meta_data, last_sign_in_at)
     VALUES ($1, NOW(), $2, $3, NOW())
     RETURNING *`,
    [
      email,
      role === 'admin',
      JSON.stringify({
        iotDbUrl,
        userDbUrl,
        ...(demoCleanupToken && { demo_cleanup_token: demoCleanupToken }),
      }),
    ],
  );
  const user = inserted.rows[0] as LoginUserRow;

  await client.query(
    'DELETE FROM dashboard_studio_meta_data.user_roles WHERE user_id = $1', [user.id],
  );
  await client.query(
    'INSERT INTO dashboard_studio_meta_data.user_roles (user_id, role) VALUES ($1, $2)',
    [user.id, role],
  );

  return { user, isNewUser: true, effectiveRole: role, demoCleanupToken };
}

/**
 * A DEMO LOGIN ON AN EXISTING ROW IS READ-ONLY. Login matches by email, so this
 * may be a REAL user — and rewriting their role and metadata was a mutation of
 * live data that no later guard could undo. Their stored role is used for the
 * token rather than the requested one.
 *
 * The ONE exception is a row that is itself ephemeral: it carries a marker, which
 * only a previous demo login can have put there, so it belongs to no real user.
 * This login takes it over with a FRESH marker — leaving the old one live would
 * let the previous demo session's cleanup delete the row out from under this one.
 * jsonb_set touches only that key, never anything the user owns.
 */
async function adoptExistingAsDemo(
  client: PoolClient,
  user: LoginUserRow,
  requestedRole: 'admin' | 'editor' | 'viewer',
): Promise<LoginIdentity> {
  logger.info('Found existing user for passwordless auth', { userId: user.id, demo: true });

  const roleRow = await client.query(
    'SELECT role FROM dashboard_studio_meta_data.user_roles WHERE user_id = $1 LIMIT 1',
    [user.id],
  );
  const effectiveRole =
    (roleRow.rows[0]?.role as 'admin' | 'editor' | 'viewer' | undefined) ?? requestedRole;

  const existingMarker = (user.raw_user_meta_data as { demo_cleanup_token?: string } | undefined)
    ?.demo_cleanup_token;
  if (!existingMarker) {
    // A real user's row: touch nothing, and mint no marker, so this session can
    // never delete it.
    return { user, isNewUser: false, effectiveRole, demoCleanupToken: undefined };
  }

  const demoCleanupToken = randomUUID();
  const rotated = await client.query(
    `UPDATE dashboard_studio_meta_data.users
        SET raw_user_meta_data =
              jsonb_set(COALESCE(raw_user_meta_data, '{}'::jsonb),
                        '{demo_cleanup_token}', to_jsonb($1::text), true),
            last_sign_in_at = NOW()
      WHERE id = $2`,
    [demoCleanupToken, user.id],
  );
  if (rotated.rowCount !== 1) {
    throw new CustomError('Login raced a concurrent change; please retry', 409);
  }
  return { user, isNewUser: false, effectiveRole, demoCleanupToken };
}

async function adoptExistingAsUser(
  client: PoolClient,
  user: LoginUserRow,
  role: 'admin' | 'editor' | 'viewer',
  iotDbUrl: string,
  userDbUrl: string,
): Promise<LoginIdentity> {
  logger.info('Found existing user for passwordless auth', { userId: user.id, demo: false });

  await client.query(
    'DELETE FROM dashboard_studio_meta_data.user_roles WHERE user_id = $1', [user.id],
  );
  await client.query(
    'INSERT INTO dashboard_studio_meta_data.user_roles (user_id, role) VALUES ($1, $2)',
    [user.id, role],
  );

  // DO NOT change this to MERGE into raw_user_meta_data. Replacing it wholesale is
  // load-bearing: it is what drops an outstanding demo cleanup marker when a REAL
  // user adopts the row, and inside this transaction that now happens atomically
  // with respect to both the demo login that minted it and the cleanup that would
  // have used it.
  const updated = await client.query(
    'UPDATE dashboard_studio_meta_data.users SET last_sign_in_at = NOW(), raw_user_meta_data = $1 WHERE id = $2',
    [JSON.stringify({ iotDbUrl, userDbUrl }), user.id],
  );
  if (updated.rowCount !== 1) {
    // Impossible while we hold FOR UPDATE on the row — assert it anyway rather
    // than mint a token for a user that is no longer there.
    throw new CustomError('Login raced a concurrent change; please retry', 409);
  }

  return { user, isNewUser: false, effectiveRole: role, demoCleanupToken: undefined };
}

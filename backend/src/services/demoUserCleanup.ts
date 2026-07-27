import type { PoolClient } from 'pg';
import { logger } from '../utils/logger.js';
import { CustomError } from '../middleware/errorHandler.js';

/** The subset of the authenticated user the cleanup decision needs. Structural,
 *  so this module does not import auth.js (which drags in DatabaseService and
 *  through it sqlSelectGuard's createRequire — unloadable under ts-jest ESM). */
export interface DemoCleanupCaller {
  demo?: boolean | undefined;
  demoCleanupToken?: string | undefined;
}

/**
 * May this caller run the demo-user cleanup at all? Returns the single-use marker
 * on success; throws a 403 otherwise (review !62 round 11, Critical 1).
 *
 * The endpoint deletes a user AND all their sections and reports, and login
 * matches by EMAIL and REUSES an existing row — so a demo sign-in with a real
 * user's address authenticates AS that user. Two conditions, both required:
 *
 *   - the caller is a demo session at all (a normal session has no business here,
 *     and this route is deliberately outside rejectDemoWrites);
 *   - it carries the marker minted only when THIS demo login CREATED the row.
 *
 * A demo login that reused a pre-existing identity carries no marker, and that
 * ABSENCE is the guarantee: it can delete nothing.
 */
export function assertDemoCleanupAllowed(caller: DemoCleanupCaller | undefined): string {
  if (caller?.demo !== true) {
    throw new CustomError('Only a demo session may delete its temporary user', 403);
  }
  if (!caller.demoCleanupToken) {
    throw new CustomError(
      'This demo session did not create its user and may not delete it',
      403,
    );
  }
  return caller.demoCleanupToken;
}

/**
 * Delete the ephemeral demo user and its data, inside the caller's OPEN
 * transaction. Returns whether anything was deleted.
 *
 * MATCHES THE ROW BEFORE DELETING ANYTHING, and holds it FOR UPDATE for the rest
 * of the transaction (review !62 round 11, Critical 1). The row's marker is
 * cleared by any later login — authenticatePasswordless replaces
 * raw_user_meta_data wholesale, deliberately — so a row that a real user has
 * since signed into no longer matches, and this returns false having touched
 * nothing. That is what closes the race between a demo cleanup still in flight
 * and a real login on the same address.
 *
 * A false return is an ordinary outcome, not an error: the row was adopted by
 * another login, or a previous attempt already cleaned it up.
 */
export async function deleteEphemeralDemoUser(
  client: PoolClient,
  userId: string,
  cleanupToken: string,
): Promise<boolean> {
  const owned = await client.query(
    `SELECT id FROM dashboard_studio_meta_data.users
      WHERE id = $1 AND raw_user_meta_data->>'demo_cleanup_token' = $2
      FOR UPDATE`,
    [userId, cleanupToken],
  );
  if (owned.rowCount === 0) {
    logger.info('Demo user cleanup skipped: the row is no longer this session\'s to delete', {
      userId,
    });
    return false;
  }

  await client.query(
    'DELETE FROM dashboard_studio_meta_data.user_roles WHERE user_id = $1',
    [userId],
  );
  // by user_id and client_id
  await client.query(
    'DELETE FROM dashboard_studio_meta_data.sections WHERE user_id = $1 OR client_id = $1',
    [userId],
  );
  await client.query(
    'DELETE FROM dashboard_studio_meta_data.reports WHERE user_id = $1 OR client_id = $1',
    [userId],
  );
  await client.query(
    'DELETE FROM dashboard_studio_meta_data.users WHERE id = $1',
    [userId],
  );
  return true;
}

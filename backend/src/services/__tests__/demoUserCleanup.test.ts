/**
 * review !62 round 11, Critical 1 — the worst defect this MR series has produced.
 *
 * DELETE /auth/demo-user deletes a user AND all their sections and reports, and
 * login matches by EMAIL and REUSES an existing row. A demo sign-in with a real
 * user's address therefore authenticated AS that user, and the cleanup that
 * always follows a demo seed deleted whatever userId the token carried. The
 * client's own liveness check ran only AFTERWARDS.
 *
 * Two independent things have to hold, and both are tested here: only a session
 * that CREATED its row may ask, and even then the row must still be the one that
 * session created — checked before anything is deleted.
 */
import { describe, it, expect } from '@jest/globals';
import type { PoolClient } from 'pg';
import { assertDemoCleanupAllowed, deleteEphemeralDemoUser } from '../demoUserCleanup.js';
import { CustomError } from '../../middleware/errorHandler.js';

const MARKER = 'marker-abc';

/** Records every statement so the ORDER of the match and the deletes is testable
 *  — the whole point is that nothing is deleted before the row is proven ours. */
function scriptedClient(rows: Array<{ id: string }>) {
  const calls: string[] = [];
  const client = {
    async query(sql: string, _params?: unknown[]) {
      const q = sql.replace(/\s+/g, ' ').trim();
      calls.push(q);
      if (q.startsWith('SELECT id FROM')) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const expect403 = (caller: Parameters<typeof assertDemoCleanupAllowed>[0], match: RegExp) => {
  try {
    assertDemoCleanupAllowed(caller);
    throw new Error('expected assertDemoCleanupAllowed to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(CustomError);
    expect((err as CustomError).statusCode).toBe(403);
    expect((err as CustomError).message).toMatch(match);
  }
};

describe('assertDemoCleanupAllowed', () => {
  it('refuses a NORMAL session outright', () => {
    // This route sits outside rejectDemoWrites, so without this check any
    // authenticated user could destroy their own sections and reports.
    expect403({ demo: false, demoCleanupToken: MARKER }, /demo session/i);
    expect403(undefined, /demo session/i);
  });

  it('refuses a demo session that did NOT create its user', () => {
    // The marker is minted only for a row this login created. A demo login that
    // reused a real user's row carries none — that absence IS the guarantee.
    expect403({ demo: true }, /did not create/i);
    expect403({ demo: true, demoCleanupToken: '' }, /did not create/i);
  });

  it('returns the marker for a demo session that created its user', () => {
    expect(assertDemoCleanupAllowed({ demo: true, demoCleanupToken: MARKER })).toBe(MARKER);
  });
});

describe('deleteEphemeralDemoUser', () => {
  it('matches the row BEFORE deleting anything, and holds it FOR UPDATE', async () => {
    const { client, calls } = scriptedClient([{ id: 'u1' }]);

    expect(await deleteEphemeralDemoUser(client, 'u1', MARKER)).toBe(true);

    expect(calls[0]).toContain('SELECT id FROM dashboard_studio_meta_data.users');
    expect(calls[0]).toContain("raw_user_meta_data->>'demo_cleanup_token' = $2");
    // A concurrent login must not be able to adopt the row between the match and
    // the deletes.
    expect(calls[0]).toContain('FOR UPDATE');
    expect(calls.slice(1).every((q) => q.startsWith('DELETE FROM'))).toBe(true);
    expect(calls).toHaveLength(5); // match + roles + sections + reports + user
  });

  it('deletes NOTHING when the row no longer carries this session\'s marker', async () => {
    // The row was adopted by a real login — authenticatePasswordless replaces
    // raw_user_meta_data wholesale, which drops an outstanding marker. This is the
    // race the reviewer named: a real user signing in while a demo cleanup is
    // still in flight.
    const { client, calls } = scriptedClient([]);

    expect(await deleteEphemeralDemoUser(client, 'u1', MARKER)).toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls.some((q) => q.startsWith('DELETE'))).toBe(false);
  });

  it('scopes every delete to the matched user id', async () => {
    const { client, calls } = scriptedClient([{ id: 'u1' }]);
    await deleteEphemeralDemoUser(client, 'u1', MARKER);

    expect(calls[1]).toContain('user_roles WHERE user_id = $1');
    expect(calls[2]).toContain('sections WHERE user_id = $1 OR client_id = $1');
    expect(calls[3]).toContain('reports WHERE user_id = $1 OR client_id = $1');
    expect(calls[4]).toContain('users WHERE id = $1');
  });
});

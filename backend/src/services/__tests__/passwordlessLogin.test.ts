/**
 * review !62 round 12, Critical 1.
 *
 * Login ran as a series of autocommit statements, so two logins for one address
 * interleaved freely and a demo cleanup marker could be written AFTER a real
 * login had already adopted the row — after which that demo session's cleanup
 * matched and deleted the user the real person was signed in as. A demo login on
 * an existing address also rewrote that person's role and metadata before any
 * guard could weigh in.
 *
 * The client here is a PROTOCOL EMULATION, not a Postgres: it models a users
 * table, the per-email advisory lock and row locks well enough to interleave two
 * logins and a cleanup deterministically. Same disclaimer as the chatStore
 * scripted pool — it proves the ORDERING contract, not the server's semantics.
 */
import { describe, it, expect } from '@jest/globals';
import type { PoolClient } from 'pg';
import { resolveLoginIdentity } from '../passwordlessLogin.js';
import { deleteEphemeralDemoUser } from '../demoUserCleanup.js';

interface Row {
  id: string;
  email: string;
  raw_user_meta_data: Record<string, unknown>;
}

/** One shared "database" plus the lock table, so several clients can contend. */
function makeDb() {
  const rows: Row[] = [];
  const roles = new Map<string, string>();
  /** email -> holder id, for pg_advisory_xact_lock. */
  const advisory = new Map<string, symbol>();
  /** row id -> holder id, for SELECT … FOR UPDATE. */
  const rowLocks = new Map<string, symbol>();
  let nextId = 1;

  function client(label: string) {
    const me = Symbol(label);
    const held: Array<Map<string, symbol>> = [];
    const calls: string[] = [];
    const c = {
      calls,
      async query(sql: string, params: unknown[] = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        calls.push(q);

        if (q === 'BEGIN') return { rows: [], rowCount: 0 };
        if (q === 'COMMIT' || q === 'ROLLBACK') {
          for (const table of held) {
            for (const [k, v] of table) if (v === me) table.delete(k);
          }
          held.length = 0;
          return { rows: [], rowCount: 0 };
        }

        if (q.includes('pg_advisory_xact_lock')) {
          const key = String(params[0]);
          const holder = advisory.get(key);
          if (holder && holder !== me) throw new Error(`advisory lock ${key} already held`);
          advisory.set(key, me);
          held.push(advisory);
          return { rows: [], rowCount: 0 };
        }

        if (q.startsWith('SELECT * FROM dashboard_studio_meta_data.users')) {
          const row = rows.find((r) => r.email === params[0]);
          if (row && q.includes('FOR UPDATE')) {
            const holder = rowLocks.get(row.id);
            if (holder && holder !== me) throw new Error(`row ${row.id} already locked`);
            rowLocks.set(row.id, me);
            held.push(rowLocks);
          }
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }

        if (q.startsWith('SELECT id FROM dashboard_studio_meta_data.users')) {
          // The cleanup's marker match, also FOR UPDATE.
          const row = rows.find(
            (r) => r.id === params[0] && r.raw_user_meta_data?.demo_cleanup_token === params[1],
          );
          if (row) {
            const holder = rowLocks.get(row.id);
            if (holder && holder !== me) throw new Error(`row ${row.id} already locked`);
            rowLocks.set(row.id, me);
            held.push(rowLocks);
          }
          return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
        }

        if (q.startsWith('INSERT INTO dashboard_studio_meta_data.users')) {
          const row: Row = {
            id: `u${nextId++}`,
            email: String(params[0]),
            raw_user_meta_data: JSON.parse(String(params[2])),
          };
          rows.push(row);
          return { rows: [row], rowCount: 1 };
        }

        if (q.includes('SET raw_user_meta_data = jsonb_set')) {
          const row = rows.find((r) => r.id === params[1]);
          if (!row) return { rows: [], rowCount: 0 };
          row.raw_user_meta_data = {
            ...row.raw_user_meta_data, demo_cleanup_token: String(params[0]),
          };
          return { rows: [], rowCount: 1 };
        }

        if (q.startsWith('UPDATE dashboard_studio_meta_data.users SET last_sign_in_at')) {
          const row = rows.find((r) => r.id === params[1]);
          if (!row) return { rows: [], rowCount: 0 };
          // Wholesale replacement — this is what drops an outstanding marker.
          row.raw_user_meta_data = JSON.parse(String(params[0]));
          return { rows: [], rowCount: 1 };
        }

        if (q.startsWith('SELECT role FROM')) {
          const role = roles.get(String(params[0]));
          return { rows: role ? [{ role }] : [], rowCount: role ? 1 : 0 };
        }
        if (q.startsWith('DELETE FROM dashboard_studio_meta_data.user_roles')) {
          roles.delete(String(params[0]));
          return { rows: [], rowCount: 1 };
        }
        if (q.startsWith('INSERT INTO dashboard_studio_meta_data.user_roles')) {
          roles.set(String(params[0]), String(params[1]));
          return { rows: [], rowCount: 1 };
        }
        if (q.startsWith('DELETE FROM')) {
          const idx = rows.findIndex((r) => r.id === params[0]);
          if (q.includes('.users WHERE id') && idx >= 0) rows.splice(idx, 1);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unscripted SQL: ${q.slice(0, 90)}`);
      },
    };
    return c as unknown as PoolClient & { calls: string[] };
  }

  return { rows, roles, client };
}

const LOGIN = { email: 'someone@navixy.io', iotDbUrl: 'postgres://iot', userDbUrl: 'postgres://s' };

describe('resolveLoginIdentity — one transaction, serialized per email', () => {
  it('takes the lock and the row lock before deciding anything', async () => {
    const db = makeDb();
    const c = db.client('demo');
    await resolveLoginIdentity(c, { ...LOGIN, role: 'admin', demo: true });

    const calls = (c as unknown as { calls: string[] }).calls;
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('pg_advisory_xact_lock');
    expect(calls[2]).toContain('FOR UPDATE');
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('writes the demo marker AT CREATION, not in a later update', async () => {
    const db = makeDb();
    const identity = await resolveLoginIdentity(
      db.client('demo'), { ...LOGIN, role: 'admin', demo: true },
    );
    expect(identity.isNewUser).toBe(true);
    expect(identity.demoCleanupToken).toEqual(expect.any(String));
    // The marker is already on the row the INSERT returned — no window in which
    // the row exists without it.
    expect(db.rows[0].raw_user_meta_data.demo_cleanup_token).toBe(identity.demoCleanupToken);
  });

  it('a NORMAL login on a fresh address mints no marker', async () => {
    const db = makeDb();
    const identity = await resolveLoginIdentity(
      db.client('normal'), { ...LOGIN, role: 'admin', demo: false },
    );
    expect(identity.demoCleanupToken).toBeUndefined();
    expect(db.rows[0].raw_user_meta_data.demo_cleanup_token).toBeUndefined();
  });
});

describe('a demo login on an EXISTING identity is read-only', () => {
  it('touches neither role nor metadata, and mints no marker', async () => {
    const db = makeDb();
    // A real user exists, as an admin, with saved preferences.
    await resolveLoginIdentity(db.client('real'), { ...LOGIN, role: 'admin', demo: false });
    db.rows[0].raw_user_meta_data.preferences = { timezone: 'Europe/Riga' };

    const c = db.client('demo');
    const identity = await resolveLoginIdentity(c, { ...LOGIN, role: 'viewer', demo: true });

    // No marker => the cleanup endpoint can never delete this person.
    expect(identity.demoCleanupToken).toBeUndefined();
    // Their role is UNCHANGED, and the token carries what the account actually
    // holds rather than what the demo login asked for.
    expect(db.roles.get(db.rows[0].id)).toBe('admin');
    expect(identity.effectiveRole).toBe('admin');
    // Their metadata is untouched.
    expect(db.rows[0].raw_user_meta_data.preferences).toEqual({ timezone: 'Europe/Riga' });
    const calls = (c as unknown as { calls: string[] }).calls;
    expect(calls.some((q) => q.startsWith('DELETE FROM dashboard_studio_meta_data.user_roles'))).toBe(false);
    expect(calls.some((q) => q.includes('SET last_sign_in_at'))).toBe(false);
  });

  it('DOES take over a row that is itself ephemeral, with a fresh marker', async () => {
    const db = makeDb();
    const first = await resolveLoginIdentity(
      db.client('demo-1'), { ...LOGIN, role: 'admin', demo: true },
    );
    const second = await resolveLoginIdentity(
      db.client('demo-2'), { ...LOGIN, role: 'admin', demo: true },
    );

    expect(second.demoCleanupToken).toEqual(expect.any(String));
    expect(second.demoCleanupToken).not.toBe(first.demoCleanupToken);
    // The FIRST session can no longer delete it — otherwise its cleanup would
    // pull the row out from under the second.
    expect(
      await deleteEphemeralDemoUser(db.client('cleanup-1'), db.rows[0].id, first.demoCleanupToken!),
    ).toBe(false);
    expect(db.rows).toHaveLength(1);
  });
});

describe('demo create <-> normal login <-> cleanup', () => {
  it('a real login adopting the row makes the demo cleanup a no-op', async () => {
    const db = makeDb();
    // 1. Demo A creates the row and holds a marker.
    const demoA = await resolveLoginIdentity(
      db.client('demo-A'), { ...LOGIN, role: 'admin', demo: true },
    );
    expect(demoA.demoCleanupToken).toEqual(expect.any(String));

    // 2. Real user B signs in on the same address. Their metadata write replaces
    //    the object wholesale, which drops A's marker.
    await resolveLoginIdentity(db.client('normal-B'), { ...LOGIN, role: 'editor', demo: false });
    expect(db.rows[0].raw_user_meta_data.demo_cleanup_token).toBeUndefined();

    // 3. A's cleanup fires afterwards — and deletes NOTHING. This is the exact
    //    sequence that used to destroy B's account.
    expect(
      await deleteEphemeralDemoUser(db.client('cleanup-A'), db.rows[0].id, demoA.demoCleanupToken!),
    ).toBe(false);
    expect(db.rows).toHaveLength(1);
    expect(db.roles.get(db.rows[0].id)).toBe('editor');
  });

  it('the cleanup still works when no one else has touched the row', async () => {
    const db = makeDb();
    const demoA = await resolveLoginIdentity(
      db.client('demo-A'), { ...LOGIN, role: 'admin', demo: true },
    );
    expect(
      await deleteEphemeralDemoUser(db.client('cleanup-A'), db.rows[0].id, demoA.demoCleanupToken!),
    ).toBe(true);
    expect(db.rows).toHaveLength(0);
  });

  it('a login holding the row lock blocks a concurrent cleanup', async () => {
    // Both take FOR UPDATE on the same row, so they cannot interleave — which is
    // what stops a cleanup landing between a login's SELECT and its UPDATE.
    const db = makeDb();
    const demoA = await resolveLoginIdentity(
      db.client('demo-A'), { ...LOGIN, role: 'admin', demo: true },
    );

    const login = db.client('normal-B');
    await login.query('BEGIN');
    await login.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:${LOGIN.email}`]);
    await login.query(
      'SELECT * FROM dashboard_studio_meta_data.users WHERE email = $1 FOR UPDATE', [LOGIN.email],
    );

    // The emulation surfaces contention as a throw where Postgres would block —
    // either way the cleanup cannot proceed while the login holds the row.
    await expect(
      deleteEphemeralDemoUser(db.client('cleanup-A'), db.rows[0].id, demoA.demoCleanupToken!),
    ).rejects.toThrow(/already locked/);
  });
});

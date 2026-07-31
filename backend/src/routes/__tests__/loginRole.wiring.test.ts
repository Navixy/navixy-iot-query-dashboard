/**
 * The login RESPONSE must carry the same role as the JWT (review !62 round 13,
 * Important 3).
 *
 * `/auth/login` echoed the role from the REQUEST BODY while the token carried the
 * account's effective role. AuthContext stores the response object as `user`, so
 * the two disagreeing is a real privilege display bug: a demo sign-in asking for
 * 'admin' on a viewer account rendered admin-only affordances (Apply) that every
 * subsequent API call — authorized by the token — would refuse.
 *
 * SOURCE-LEVEL, not by importing the router: app.ts pulls in DatabaseService and
 * through it sqlSelectGuard's `createRequire(import.meta.url)`, which this repo's
 * ts-jest ESM setup cannot load. Same technique, and same reason, as
 * demoWriteGuard.wiring.test.ts. The VALUE being propagated is covered
 * behaviourally in services/__tests__/passwordlessLogin.test.ts.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// From the jest rootDir (backend/), not import.meta — ts-jest compiles this
// suite to CJS, where import.meta is a syntax error.
const appSource = readFileSync(join(process.cwd(), 'src', 'routes', 'app.ts'), 'utf8');

/** The `user: { … }` object literal inside the /auth/login response. */
function loginResponseUserBlock(): string {
  const start = appSource.indexOf("router.post('/auth/login'");
  expect(start).toBeGreaterThan(-1);
  const body = appSource.slice(start, appSource.indexOf("router.", start + 10));
  const userAt = body.indexOf('user: {');
  expect(userAt).toBeGreaterThan(-1);
  return body.slice(userAt, body.indexOf('},', userAt));
}

describe('/auth/login response role', () => {
  it('returns the resolved effective role, not the requested one', () => {
    const block = loginResponseUserBlock();

    expect(block).toContain('result.effectiveRole');
  });

  it('does NOT echo the request-body role', () => {
    const block = loginResponseUserBlock();

    // `role: role` (or the shorthand `role,`) is the regression: that identifier is
    // destructured straight off req.body and is caller-controlled.
    expect(block).not.toMatch(/role:\s*role\b/);
    expect(block).not.toMatch(/^\s*role,\s*$/m);
  });

  it('takes it from the auth service result, which is what mints the token', () => {
    // Both must come from the SAME resolved identity — the divergence existed
    // precisely because the token read one source and the response another.
    expect(appSource).toMatch(/const result = await dbService\.authenticateUserPasswordless/);
    expect(appSource).toMatch(/token:\s*result\.token/);
  });
});

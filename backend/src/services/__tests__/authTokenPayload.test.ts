/**
 * review !62 round 10, Important 4. Cross-tab session invalidation is keyed on
 * the origin-wide localStorage.auth_token CHANGING VALUE — writing a key the
 * value it already holds fires no storage event. Everything in the login payload
 * is determined by the request, and `iat` has one-second resolution, so before
 * the jti two logins with the same credentials in the same second minted
 * byte-identical tokens: no divergence, no event, both tabs live, both able to
 * post into the same stateful chat session.
 */
import { describe, it, expect } from '@jest/globals';
import { buildAuthTokenPayload } from '../authTokenPayload.js';
import type { AuthTokenClaims } from '../authTokenPayload.js';

const CLAIMS: AuthTokenClaims = {
  userId: 'u1',
  email: 'someone@navixy.io',
  role: 'admin',
  iotDbUrl: 'postgres://iot',
  userDbUrl: 'postgres://settings',
  demo: false,
};

describe('buildAuthTokenPayload', () => {
  it('gives two IDENTICAL logins different payloads', () => {
    const a = buildAuthTokenPayload(CLAIMS);
    const b = buildAuthTokenPayload(CLAIMS);

    expect(a.jti).toEqual(expect.any(String));
    expect(a.jti).not.toBe(b.jti);
    // The jti must be the ONLY difference — nothing else may drift per login.
    expect({ ...a, jti: null }).toEqual({ ...b, jti: null });
  });

  it('carries every claim the middleware and routes read', () => {
    const payload = buildAuthTokenPayload({ ...CLAIMS, demo: true });
    expect(payload).toMatchObject({
      userId: 'u1',
      email: 'someone@navixy.io',
      role: 'admin',
      iotDbUrl: 'postgres://iot',
      userDbUrl: 'postgres://settings',
      demo: true,
    });
  });

  it('forwards a host session_id when present and omits the key when not', () => {
    expect(buildAuthTokenPayload({ ...CLAIMS, sessionId: 'host-42' }).session_id).toBe('host-42');
    expect('session_id' in buildAuthTokenPayload(CLAIMS)).toBe(false);
    // An empty string is not a session id — omit rather than forward a blank.
    expect('session_id' in buildAuthTokenPayload({ ...CLAIMS, sessionId: '' })).toBe(false);
  });
});

/**
 * review !62 round 11, Critical 1. Login matches by EMAIL and REUSES an existing
 * row, so a demo sign-in with a real user's address authenticates AS that user —
 * and the demo cleanup that follows used to delete whatever userId the token
 * carried, taking their roles, sections and reports with it. The marker is the
 * server-side proof that this login CREATED the row it is about to delete.
 */
describe('buildAuthTokenPayload — demo cleanup marker', () => {
  it('carries the marker when one was minted', () => {
    const payload = buildAuthTokenPayload({
      ...CLAIMS, demo: true, demoCleanupToken: 'marker-1',
    });
    expect(payload.demo_cleanup_token).toBe('marker-1');
  });

  it('omits the claim entirely when no marker was minted', () => {
    // A demo login that REUSED a pre-existing identity gets no marker, so the
    // cleanup endpoint refuses it — this absence is the whole guarantee.
    expect('demo_cleanup_token' in buildAuthTokenPayload({ ...CLAIMS, demo: true })).toBe(false);
    expect('demo_cleanup_token' in buildAuthTokenPayload(CLAIMS)).toBe(false);
  });

  it('is unique per login, like the jti', () => {
    const a = buildAuthTokenPayload({ ...CLAIMS, demo: true, demoCleanupToken: 'm1' });
    const b = buildAuthTokenPayload({ ...CLAIMS, demo: true, demoCleanupToken: 'm2' });
    expect(a.demo_cleanup_token).not.toBe(b.demo_cleanup_token);
  });
});

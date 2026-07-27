import { randomUUID } from 'node:crypto';

/** Everything the login endpoint knows about the session being minted. */
export interface AuthTokenClaims {
  userId: string;
  email: string;
  role: string;
  iotDbUrl: string;
  userDbUrl: string;
  demo: boolean;
  /** Host-supplied session id, forwarded verbatim when present. NOTE: this is
   *  the HOST's session, unrelated to the chat session. */
  sessionId?: string | undefined;
}

/**
 * Build the JWT payload for one login.
 *
 * EVERY LOGIN MUST PRODUCE A DISTINCT TOKEN (review !62 round 10, Important 4).
 * Everything above is fully determined by the request, and `iat` — the only
 * claim jwt.sign adds by itself — has ONE-SECOND resolution, so two logins with
 * the same credentials inside the same second used to serialize to BYTE-IDENTICAL
 * tokens. The browser keeps the token in the origin-wide localStorage.auth_token,
 * and writing a key the value it already holds fires NO storage event: the
 * cross-tab session ender never runs, both tabs stay live believing each owns the
 * session, and they can post into the same stateful chat session concurrently.
 *
 * The `jti` is what makes the token unique, so the whole cross-tab invalidation
 * mechanism — which is keyed on the token VALUE changing — actually fires. It
 * also gives a login a stable handle for logs without echoing the token bytes.
 * Extracted here rather than inlined at the jwt.sign call so the invariant is
 * unit-testable: database.ts drags in sqlSelectGuard's createRequire, which this
 * repo's ts-jest ESM setup cannot load.
 */
export function buildAuthTokenPayload(claims: AuthTokenClaims): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    userId: claims.userId,
    email: claims.email,
    role: claims.role,
    iotDbUrl: claims.iotDbUrl,
    userDbUrl: claims.userDbUrl,
    demo: claims.demo,
    jti: randomUUID(),
  };
  if (claims.sessionId) {
    payload.session_id = claims.sessionId;
  }
  return payload;
}

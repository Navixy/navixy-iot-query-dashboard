/**
 * Auth-session epoch (DO-313, review !62 round 2 — Critical 2).
 *
 * One opaque id per authenticated presence on this tab: minted at sign-in and at
 * token restore, dropped at sign-out. It exists because nothing else is safe to
 * scope client-side caches by:
 *
 * - `user.id` is the tenant database's own users.id — unique only WITHIN that
 *   tenant. User 7 of tenant A and user 7 of tenant B are different people with
 *   colliding ids, so an id-scoped query key hands one tenant's cached
 *   transcript to the other on a shared machine.
 * - `queryClient.clear()` on sign-out empties the caches but cannot stop an
 *   in-flight mutation: TanStack v5 mutations are not cancellable, and their
 *   hook-level callbacks still run when the request settles — after the next
 *   user has signed in and repopulated a cache under the same key.
 *
 * Query and mutation keys carry this epoch, and settled callbacks compare their
 * captured epoch against the CURRENT one before touching any cache: a reply that
 * started under a signed-out session is dropped, never written into the next
 * identity's view.
 *
 * Module-level on purpose: the callbacks need the value OUTSIDE React's render
 * cycle — a closure over context state is frozen at mutate time, which is
 * exactly the stale value the comparison must detect. AuthContext mirrors the
 * epoch into state so components re-render when it changes; this module is the
 * single writer.
 */
let currentAuthSessionId: string | null = null;

/**
 * The bearer token THIS TAB authenticated with, captured when the epoch is minted
 * and dropped at sign-out (review !62 round 8, finding 1). It is the tab's fixed
 * identity anchor: localStorage.auth_token is ORIGIN-WIDE, so a sign-in in another
 * tab overwrites it WITHOUT moving this tab's epoch. Comparing the shared token
 * against THIS anchor is how the tab detects it has gone stale — the round-6/7
 * binding only re-read localStorage and so could not tell "already stale from the
 * start" (localStorage was the successor's before the send even began) from a
 * healthy send. Module-level, tab-scoped: never leaves this tab.
 */
let tabSessionToken: string | null = null;

export function beginAuthSession(token: string | null = null): string {
  // randomUUID needs a secure context. localhost and the https iframe host both
  // qualify, but a plain-http deploy must not crash sign-in over a cache-scoping
  // nonce — the fallback only needs uniqueness per sign-in on one tab.
  currentAuthSessionId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // Anchor the tab to the token it authenticated with (finding 1). Callers pass
  // the token they just stored in localStorage; a restore re-anchors to it too.
  tabSessionToken = token;
  return currentAuthSessionId;
}

export function endAuthSession(): void {
  currentAuthSessionId = null;
  tabSessionToken = null;
}

export function getAuthSessionId(): string | null {
  return currentAuthSessionId;
}

/**
 * The token THIS TAB authenticated with (review !62 round 8, finding 1). The chat
 * send binds THIS — not a fresh localStorage read — so a tab that was already
 * stale when the user hit send (another tab had swapped the origin-wide token
 * before the send began) cannot POST under the successor's identity. Compared
 * against getAuthToken() to detect divergence; see isForeignAuthChange.
 */
export function getTabSessionToken(): string | null {
  return tabSessionToken;
}

/**
 * The bearer token the API layer will actually send: api.ts reads this SAME
 * localStorage key at request time (getAuthHeaders). Origin-wide, so a cross-tab
 * sign-in swaps it under a tab whose epoch never moved (review !62 round 6,
 * Critical 1; round 8, finding 1). Guarded for non-browser contexts (node-env
 * unit tests) where localStorage is absent.
 */
export function getAuthToken(): string | null {
  return typeof localStorage !== 'undefined' ? localStorage.getItem('auth_token') : null;
}

/**
 * True when the origin-wide auth_token has moved to a DIFFERENT value than the one
 * THIS TAB holds — a cross-tab sign-in under another identity, or a cross-tab
 * sign-out (newValue null) — review !62 round 8, finding 1. Only meaningful when
 * the tab actually has a session (tabToken non-null); a tab with no authenticated
 * presence has nothing to invalidate, so a foreign write is ignored. The single
 * decision the storage-event listener acts on; pure so it is unit-testable.
 */
export function isForeignAuthChange(
  tabToken: string | null,
  incoming: string | null,
): boolean {
  return tabToken !== null && incoming !== tabToken;
}

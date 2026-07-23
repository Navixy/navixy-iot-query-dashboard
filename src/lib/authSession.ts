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

export function beginAuthSession(): string {
  // randomUUID needs a secure context. localhost and the https iframe host both
  // qualify, but a plain-http deploy must not crash sign-in over a cache-scoping
  // nonce — the fallback only needs uniqueness per sign-in on one tab.
  currentAuthSessionId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return currentAuthSessionId;
}

export function endAuthSession(): void {
  currentAuthSessionId = null;
}

export function getAuthSessionId(): string | null {
  return currentAuthSessionId;
}

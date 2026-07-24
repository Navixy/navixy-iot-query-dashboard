/**
 * Tab-scoped auth-session identity (review !62 round 8, finding 1). The epoch
 * scopes caches; the TAB SESSION TOKEN anchors the tab to the identity it
 * authenticated with, and isForeignAuthChange is the single predicate the
 * storage-event listener acts on to end a stale tab. Node env — no localStorage,
 * no DOM; pure module state and a pure function.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginAuthSession,
  endAuthSession,
  getAuthSessionId,
  getTabSessionToken,
  isForeignAuthChange,
} from '../authSession';

afterEach(() => endAuthSession());

describe('tab session token lifecycle', () => {
  it('anchors the tab to the token passed at beginAuthSession and drops it at end', () => {
    expect(getTabSessionToken()).toBeNull();
    const epoch = beginAuthSession('token-A');
    expect(epoch).toBeTruthy();
    expect(getAuthSessionId()).toBe(epoch);
    expect(getTabSessionToken()).toBe('token-A');
    endAuthSession();
    expect(getAuthSessionId()).toBeNull();
    expect(getTabSessionToken()).toBeNull();
  });

  it('a new sign-in re-anchors to the new token (a fresh epoch too)', () => {
    const a = beginAuthSession('token-A');
    const b = beginAuthSession('token-B');
    expect(b).not.toBe(a);
    expect(getTabSessionToken()).toBe('token-B');
  });

  it('defaults to a null anchor when no token is supplied (headless callers)', () => {
    beginAuthSession();
    expect(getAuthSessionId()).not.toBeNull();
    expect(getTabSessionToken()).toBeNull();
  });
});

describe('isForeignAuthChange — the storage-event decision', () => {
  it('is foreign when a signed-in tab sees a DIFFERENT origin token', () => {
    expect(isForeignAuthChange('token-A', 'token-B')).toBe(true);
  });

  it('is foreign when a signed-in tab sees the token REMOVED (cross-tab sign-out)', () => {
    expect(isForeignAuthChange('token-A', null)).toBe(true);
  });

  it('is NOT foreign when the token is unchanged', () => {
    expect(isForeignAuthChange('token-A', 'token-A')).toBe(false);
  });

  it('is NEVER foreign for a tab with no session to invalidate', () => {
    expect(isForeignAuthChange(null, 'token-B')).toBe(false);
    expect(isForeignAuthChange(null, null)).toBe(false);
  });
});

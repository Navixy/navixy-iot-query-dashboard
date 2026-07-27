/**
 * @vitest-environment jsdom
 *
 * The demo destructive callers must guard their IndexedDB work with an
 * ORIGIN-WIDE ownership token (review !62 round 7, finding 1), not the tab-local
 * generation ref round 6 used — that could not see a concurrent demo sign-in in
 * another tab. These pin that signInDemo CLAIMS a token and passes it, that
 * reseedDemoData asserts the CURRENT token, and that a superseded run (the
 * destructive op returning false) is PROPAGATED so the caller aborts its
 * continuation instead of resurrecting/reloading the successor.
 *
 * jsdom is scoped to this file via the pragma above.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext';
import { demoStorageService } from '@/services/demoStorage';
import {
  endAuthSession,
  getDemoOwnership,
  getDemoOwnerToken,
  resetDemoOwnershipToPageLoad,
} from '@/lib/authSession';
import { isDemoMode, setDemoMode } from '@/services/demoApi';

vi.mock('@/services/demoStorage', () => ({
  demoStorageService: {
    claimDemoOwnership: vi.fn().mockResolvedValue('owner-1'),
    readDemoOwner: vi.fn().mockResolvedValue('owner-1'),
    clearAllData: vi.fn().mockResolvedValue(true),
    seedFromBackend: vi.fn().mockResolvedValue(true),
    isSeeded: vi.fn().mockResolvedValue(false),
  },
}));
vi.mock('@/services/demoApi', () => ({
  isDemoMode: vi.fn(() => false),
  setDemoMode: vi.fn(),
  setDemoUserId: vi.fn(),
}));
vi.mock('@/lib/queryClient', () => ({ queryClient: { clear: vi.fn() } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

function stubFetch() {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith('/api/auth/login')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          token: 'demo-token',
          user: { id: 'u1', email: 'demo@navixy.io', role: 'admin' },
        }),
      } as Response;
    }
    if (u.endsWith('/api/auth/demo-user')) {
      return { ok: true, json: async () => ({}) } as Response;
    }
    if (u.endsWith('/api/auth/me')) {
      // verifyToken reads text() then JSON.parses it.
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            user: { id: 'u1', email: 'demo@navixy.io', role: 'admin' },
          }),
      } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ sections: [], reports: [], variables: [], catalog: null, data: [] }),
    } as Response;
  }) as unknown as typeof fetch;
}

interface Ctx {
  signIn: ReturnType<typeof useAuth>['signIn'];
  signInDemo: ReturnType<typeof useAuth>['signInDemo'];
  reseedDemoData: ReturnType<typeof useAuth>['reseedDemoData'];
  clearDemoData: ReturnType<typeof useAuth>['clearDemoData'];
  signOut: ReturnType<typeof useAuth>['signOut'];
}
let ctx: Ctx;
function Grab() {
  const c = useAuth();
  ctx = {
    signIn: c.signIn, signInDemo: c.signInDemo, reseedDemoData: c.reseedDemoData,
    clearDemoData: c.clearDemoData, signOut: c.signOut,
  };
  return null;
}
function mount() {
  render(createElement(AuthProvider, null, createElement(Grab)));
}

const CREDS = ['demo@navixy.io', 'admin', 'iot-url', 'user-url'] as const;

beforeEach(() => {
  localStorage.clear();
  endAuthSession(); // reset the tab-scoped anchors between tests (round 8, finding 2)
  resetDemoOwnershipToPageLoad(); // ...and back to the PAGE-LOAD demo standing (round 10)
  vi.clearAllMocks();
  vi.mocked(demoStorageService.claimDemoOwnership).mockResolvedValue('owner-1');
  vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue('owner-1');
  vi.mocked(demoStorageService.clearAllData).mockResolvedValue(true);
  vi.mocked(demoStorageService.seedFromBackend).mockResolvedValue(true);
  vi.mocked(demoStorageService.isSeeded).mockResolvedValue(false);
  vi.mocked(isDemoMode).mockReturnValue(false);
  stubFetch();
});
afterEach(() => cleanup());

/** A JWT whose payload carries the demo flag — verifyToken only base64-decodes
 *  the middle segment, so header and signature can be anything. */
const DEMO_JWT = `h.${btoa(JSON.stringify({ demo: true }))}.s`;
/** Let the mount-time verifyToken (a fetch plus a few awaits) settle. */
const settleRestore = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('signInDemo — origin-wide ownership token (review !62 round 7, finding 1)', () => {
  it('claims a token and passes it to both clearAllData and seedFromBackend', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS);
    });
    expect(demoStorageService.claimDemoOwnership).toHaveBeenCalled();
    expect(demoStorageService.clearAllData).toHaveBeenCalledWith('owner-1');
    expect(demoStorageService.seedFromBackend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'owner-1',
    );
  });

  it('returns an error when the seed is superseded (ownership moved on)', async () => {
    vi.mocked(demoStorageService.seedFromBackend).mockResolvedValue(false);
    mount();
    let result: { error: Error | null } | undefined;
    await act(async () => {
      result = await ctx.signInDemo(...CREDS);
    });
    expect(result?.error).toBeInstanceOf(Error);
  });
});

describe('reseedDemoData — asserts THIS TAB\'s owner anchor (review !62 round 8, finding 2)', () => {
  it('passes the token this tab claimed at sign-in, NOT a fresh readDemoOwner', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS); // anchors this tab to 'owner-1'
    });
    // signInDemo reads the owner once (its own post-seed supersession check);
    // clear that history so the assertion below measures reseed alone.
    vi.mocked(demoStorageService.readDemoOwner).mockClear();
    vi.mocked(demoStorageService.seedFromBackend).mockClear();

    await act(async () => {
      await ctx.reseedDemoData();
    });
    // The fix: reseed asserts the tab's OWN anchor, so it never re-reads the
    // current owner (which for a stale tab would be the successor's token).
    expect(demoStorageService.readDemoOwner).not.toHaveBeenCalled();
    expect(demoStorageService.seedFromBackend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'owner-1',
    );
  });

  it('returns an error (so Settings does NOT reload) when the seed is superseded', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS);
    });
    vi.mocked(demoStorageService.seedFromBackend).mockResolvedValue(false);
    let result: { error: Error | null } | undefined;
    await act(async () => {
      result = await ctx.reseedDemoData();
    });
    expect(result?.error).toBeInstanceOf(Error);
  });
});

describe('clearDemoData — propagates the abort (review !62 round 7, finding 1)', () => {
  it('reports { aborted: true } when the clear was superseded, so DemoBanner skips sign-out', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS);
    });
    vi.mocked(demoStorageService.clearAllData).mockResolvedValue(false);
    let result: { aborted: boolean } | undefined;
    await act(async () => {
      result = await ctx.clearDemoData();
    });
    expect(result).toEqual({ aborted: true });
  });

  it('reports { aborted: false } on a normal clear', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS);
    });
    let result: { aborted: boolean } | undefined;
    await act(async () => {
      result = await ctx.clearDemoData();
    });
    expect(result).toEqual({ aborted: false });
  });
});

/**
 * review !62 round 9, finding 2. Round 8 anchored the owner token only where the
 * session was CREATED. A tab that RESTORES an already-seeded demo session — the
 * ordinary page reload — reached the destructive paths with no anchor at all, and
 * `?? undefined` turned that absence into an explicit licence for an
 * UNCONDITIONAL clear/reseed of a store that may by then belong to someone else.
 * Restoring now adopts the origin's current owner, and a demo session that
 * somehow holds no anchor refuses to act rather than acting unconditionally.
 */
describe('restoring a demo session anchors this tab (round 9, finding 2)', () => {
  it('adopts the current origin owner when the store is ALREADY seeded', async () => {
    localStorage.setItem('auth_token', DEMO_JWT);
    vi.mocked(demoStorageService.isSeeded).mockResolvedValue(true);
    vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue('owner-live');

    mount();
    await settleRestore();

    expect(getDemoOwnerToken()).toBe('owner-live');
    // Adopting must not steal the store from whoever holds it.
    expect(demoStorageService.claimDemoOwnership).not.toHaveBeenCalled();
  });

  it('adopts on a reload that is already in demo mode', async () => {
    localStorage.setItem('auth_token', DEMO_JWT);
    vi.mocked(isDemoMode).mockReturnValue(true);
    vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue('owner-live');

    mount();
    await settleRestore();

    expect(getDemoOwnerToken()).toBe('owner-live');
  });

  it('claims when the store has NO owner yet (a pre-owner legacy store)', async () => {
    localStorage.setItem('auth_token', DEMO_JWT);
    vi.mocked(isDemoMode).mockReturnValue(true);
    vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue(undefined);
    vi.mocked(demoStorageService.claimDemoOwnership).mockResolvedValue('owner-fresh');

    mount();
    await settleRestore();

    expect(getDemoOwnerToken()).toBe('owner-fresh');
  });
});

describe('a demo session with no anchor refuses to act (round 9, finding 2)', () => {
  it('clearDemoData aborts instead of clearing unconditionally', async () => {
    vi.mocked(isDemoMode).mockReturnValue(true); // origin is in demo mode...
    mount(); // ...but this tab never established a session, so it holds no claim
    let result: { aborted: boolean } | undefined;
    await act(async () => {
      result = await ctx.clearDemoData();
    });
    expect(result).toEqual({ aborted: true });
    expect(demoStorageService.clearAllData).not.toHaveBeenCalled();
  });

  it('reseedDemoData errors instead of seeding unconditionally', async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    localStorage.setItem('auth_token', DEMO_JWT);
    vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue('owner-live');
    mount();
    await settleRestore(); // token+user restored, anchor adopted
    // Now lose the anchor the way a torn-down tab would.
    endAuthSession();
    vi.mocked(demoStorageService.seedFromBackend).mockClear();

    let result: { error: Error | null } | undefined;
    await act(async () => {
      result = await ctx.reseedDemoData();
    });
    expect(result?.error).toBeInstanceOf(Error);
    expect(demoStorageService.seedFromBackend).not.toHaveBeenCalled();
  });
});

describe('a non-demo sign-in invalidates the origin\'s demo ownership (round 9, finding 2)', () => {
  it('rotates the owner token and anchors it to nobody', async () => {
    vi.mocked(isDemoMode).mockReturnValue(true); // switching AWAY from demo
    vi.mocked(demoStorageService.claimDemoOwnership).mockResolvedValue('owner-rotated');
    mount();

    await act(async () => {
      await ctx.signIn(...CREDS);
    });

    // Rotated: every tab still anchored to the old token is now superseded...
    expect(demoStorageService.claimDemoOwnership).toHaveBeenCalled();
    // ...including this one, which owns no demo store at all.
    expect(getDemoOwnerToken()).toBeNull();
  });

  it('does not touch demo storage when the origin was never in demo mode', async () => {
    vi.mocked(isDemoMode).mockReturnValue(false);
    mount();
    await act(async () => {
      await ctx.signIn(...CREDS);
    });
    expect(demoStorageService.claimDemoOwnership).not.toHaveBeenCalled();
  });

  it('a FAILED sign-in leaves the origin-wide demo state alone', async () => {
    // Same defect class as the stale-tab teardown: clearing the shared flags up
    // front broke a demo session live in another tab on behalf of a sign-in that
    // never happened.
    vi.mocked(isDemoMode).mockReturnValue(true);
    global.fetch = vi.fn(async () => ({
      ok: false,
      text: async () => JSON.stringify({ error: { message: 'nope' } }),
    })) as unknown as typeof fetch;
    mount();

    let result: { error: Error | null } | undefined;
    await act(async () => {
      result = await ctx.signIn(...CREDS);
    });

    expect(result?.error).toBeInstanceOf(Error);
    expect(setDemoMode).not.toHaveBeenCalled();
    expect(demoStorageService.claimDemoOwnership).not.toHaveBeenCalled();
  });
});

describe('a superseded tab asserts its OWN anchor (review !62 round 8, finding 2)', () => {
  it('clearDemoData passes the tab\'s claimed token, not the successor\'s, and propagates the abort', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS); // this tab anchored to 'owner-1'
    });
    // A newer demo sign-in (another tab) is now the owner; the singleton store's
    // in-transaction guard aborts a clear that does not hold the CURRENT token.
    vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue('owner-successor');
    vi.mocked(demoStorageService.clearAllData).mockResolvedValue(false);
    vi.mocked(demoStorageService.clearAllData).mockClear();

    let result: { aborted: boolean } | undefined;
    await act(async () => {
      result = await ctx.clearDemoData();
    });
    // The fix: it asserts the tab's OWN anchor ('owner-1'), never re-reading the
    // successor's current token — so the storage guard can and does abort.
    expect(demoStorageService.clearAllData).toHaveBeenCalledWith('owner-1');
    expect(result).toEqual({ aborted: true });
  });

  it('reseedDemoData passes the tab\'s claimed token and errors when superseded', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS);
    });
    vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue('owner-successor');
    vi.mocked(demoStorageService.seedFromBackend).mockResolvedValue(false);
    vi.mocked(demoStorageService.seedFromBackend).mockClear();

    let result: { error: Error | null } | undefined;
    await act(async () => {
      result = await ctx.reseedDemoData();
    });
    expect(demoStorageService.seedFromBackend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'owner-1',
    );
    expect(result?.error).toBeInstanceOf(Error);
  });
});

/**
 * review !62 round 10, Critical 1 & 2. Two ordering invariants that the guards in
 * demoStorage and the backend both depend on.
 */
describe('demo ownership is settled BEFORE `user` is published (round 10, Critical 1)', () => {
  it('does not publish `user` until the ownership adoption has resolved', async () => {
    // Every demo-backed query is gated on `user`, and a tab with no claim is
    // exactly what the storage guard must now refuse — so publishing `user` while
    // ownership is still unsettled would make those queries read empty.
    //
    // Probed by HOLDING the adoption open: with `user` published first (the old
    // order) it would already be non-null here.
    localStorage.setItem('auth_token', DEMO_JWT);
    vi.mocked(isDemoMode).mockReturnValue(true);
    let adopt!: (token: string) => void;
    vi.mocked(demoStorageService.readDemoOwner).mockReturnValue(
      new Promise<string>((resolve) => { adopt = resolve; }),
    );

    let seenUser: unknown = undefined;
    function Watch() {
      seenUser = useAuth().user;
      return null;
    }
    render(createElement(AuthProvider, null, createElement(Watch)));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(seenUser).toBeNull();          // still gated on the pending adoption
    expect(getDemoOwnership().status).not.toBe('owned');

    await act(async () => {
      adopt('owner-live');
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(seenUser).not.toBeNull();      // published only now
    expect(getDemoOwnership().status).toBe('owned');
  });

  it('a NON-demo restore revokes rather than merely holding no claim', async () => {
    localStorage.setItem('auth_token', 'h.e30.s'); // no demo flag in the payload
    vi.mocked(isDemoMode).mockReturnValue(true); // ...but the origin still says demo
    mount();
    await settleRestore();

    expect(getDemoOwnership().status).toBe('revoked');
  });
});

describe('the demo/normal transition publishes in a safe order (round 10, Critical 2)', () => {
  it('writes the new auth_token BEFORE clearing the shared demo flags', async () => {
    // api.ts routes on the ORIGIN-WIDE isDemoMode() at call time. Clearing the
    // flags first left other tabs holding a demo JWT but reading a non-demo flag,
    // so their CRUD went to the real backend. Publishing the token first means
    // their storage events are already queued when the flags flip.
    vi.mocked(isDemoMode).mockReturnValue(true);
    let tokenAtFlagClear: string | null = 'not-called';
    vi.mocked(setDemoMode).mockImplementation((enabled: boolean) => {
      if (!enabled) tokenAtFlagClear = localStorage.getItem('auth_token');
    });
    mount();

    await act(async () => {
      await ctx.signIn(...CREDS);
    });

    expect(tokenAtFlagClear).toBe('demo-token'); // the value stubFetch returns
  });

  it('a demo sign-in claims and clears ONLY after the login succeeds', async () => {
    // Claiming up front meant a demo login that was about to FAIL had already
    // taken ownership from a live demo session in another tab and wiped its data.
    global.fetch = vi.fn(async () => ({
      ok: false,
      text: async () => JSON.stringify({ error: { message: 'bad credentials' } }),
    })) as unknown as typeof fetch;
    mount();

    let result: { error: Error | null } | undefined;
    await act(async () => {
      result = await ctx.signInDemo(...CREDS);
    });

    expect(result?.error).toBeInstanceOf(Error);
    expect(demoStorageService.claimDemoOwnership).not.toHaveBeenCalled();
    expect(demoStorageService.clearAllData).not.toHaveBeenCalled();
  });

  it('a successful demo sign-in still claims and clears before seeding', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS);
    });
    expect(demoStorageService.claimDemoOwnership).toHaveBeenCalled();
    expect(demoStorageService.clearAllData).toHaveBeenCalledWith('owner-1');
    expect(getDemoOwnerToken()).toBe('owner-1');
  });
});

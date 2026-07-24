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
import { endAuthSession } from '@/lib/authSession';

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
    return {
      ok: true,
      json: async () => ({ sections: [], reports: [], variables: [], catalog: null, data: [] }),
    } as Response;
  }) as unknown as typeof fetch;
}

interface Ctx {
  signInDemo: ReturnType<typeof useAuth>['signInDemo'];
  reseedDemoData: ReturnType<typeof useAuth>['reseedDemoData'];
  clearDemoData: ReturnType<typeof useAuth>['clearDemoData'];
  signOut: ReturnType<typeof useAuth>['signOut'];
}
let ctx: Ctx;
function Grab() {
  const c = useAuth();
  ctx = {
    signInDemo: c.signInDemo, reseedDemoData: c.reseedDemoData,
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
  vi.clearAllMocks();
  vi.mocked(demoStorageService.claimDemoOwnership).mockResolvedValue('owner-1');
  vi.mocked(demoStorageService.readDemoOwner).mockResolvedValue('owner-1');
  vi.mocked(demoStorageService.clearAllData).mockResolvedValue(true);
  vi.mocked(demoStorageService.seedFromBackend).mockResolvedValue(true);
  vi.mocked(demoStorageService.isSeeded).mockResolvedValue(false);
  stubFetch();
});
afterEach(() => cleanup());

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
    vi.mocked(demoStorageService.clearAllData).mockResolvedValue(false);
    mount();
    let result: { aborted: boolean } | undefined;
    await act(async () => {
      result = await ctx.clearDemoData();
    });
    expect(result).toEqual({ aborted: true });
  });

  it('reports { aborted: false } on a normal clear', async () => {
    mount();
    let result: { aborted: boolean } | undefined;
    await act(async () => {
      result = await ctx.clearDemoData();
    });
    expect(result).toEqual({ aborted: false });
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

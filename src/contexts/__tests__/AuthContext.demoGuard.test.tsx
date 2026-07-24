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

describe('reseedDemoData — asserts current ownership (review !62 round 7, finding 1)', () => {
  it('reads the current owner and passes it to the seed', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo(...CREDS); // establish an authenticated demo session
    });
    vi.mocked(demoStorageService.seedFromBackend).mockClear();

    await act(async () => {
      await ctx.reseedDemoData();
    });
    expect(demoStorageService.readDemoOwner).toHaveBeenCalled();
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

/**
 * @vitest-environment jsdom
 *
 * The demo destructive callers must carry the same session-liveness predicate
 * that round 5 added to the demoStorage primitives (review !62 round 6, Critical
 * 2). The predicate existed and was tested, but only initializeDemoStorage (the
 * JWT-restore path) passed it. The PRIMARY destructive callers — signInDemo and
 * reseedDemoData — still cleared and reseeded the singleton IndexedDB without
 * it, so a delayed run could resume after a sign-out/sign-in and clobber the new
 * identity's store. These tests pin that both callers now pass a predicate AND
 * that the predicate reports staleness once a later auth transition supersedes
 * the run.
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
    clearAllData: vi.fn().mockResolvedValue(undefined),
    seedFromBackend: vi.fn().mockResolvedValue(undefined),
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

// A single fetch stub covering the demo login flow: POST /login, the four
// read-only data fetches, and the demo-user DELETE. Shapes match what
// signInDemo/reseedDemoData destructure.
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
  signOut: ReturnType<typeof useAuth>['signOut'];
  user: ReturnType<typeof useAuth>['user'];
}
let ctx: Ctx;
function Grab() {
  const c = useAuth();
  ctx = { signInDemo: c.signInDemo, reseedDemoData: c.reseedDemoData, signOut: c.signOut, user: c.user };
  return null;
}
function mount() {
  // createElement rather than JSX: vitest.config.ts wires no React JSX runtime,
  // and this keeps the test independent of that config.
  render(createElement(AuthProvider, null, createElement(Grab)));
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(demoStorageService.clearAllData).mockResolvedValue(undefined);
  vi.mocked(demoStorageService.seedFromBackend).mockResolvedValue(undefined);
  vi.mocked(demoStorageService.isSeeded).mockResolvedValue(false);
  stubFetch();
});
afterEach(() => cleanup());

describe('signInDemo — destructive IndexedDB work is guarded by a liveness predicate (review !62 round 6, Critical 2)', () => {
  it('passes a predicate to both clearAllData and seedFromBackend', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo('demo@navixy.io', 'admin', 'iot-url', 'user-url');
    });
    expect(demoStorageService.clearAllData).toHaveBeenCalledWith(expect.any(Function));
    expect(demoStorageService.seedFromBackend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      expect.any(Function),
    );
  });

  it('the predicate reports stale once a later sign-out supersedes the attempt', async () => {
    mount();
    await act(async () => {
      await ctx.signInDemo('demo@navixy.io', 'admin', 'iot-url', 'user-url');
    });
    const seedArgs = vi.mocked(demoStorageService.seedFromBackend).mock.calls[0];
    const isStale = seedArgs[1] as () => boolean;
    // Same session that seeded → not stale.
    expect(isStale()).toBe(false);
    // A later explicit transition bumps the auth generation → stale.
    await act(async () => {
      await ctx.signOut();
    });
    expect(isStale()).toBe(true);
  });
});

describe('reseedDemoData — destructive reseed is guarded too (review !62 round 6, Critical 2)', () => {
  it('passes a predicate to seedFromBackend and it goes stale on sign-out', async () => {
    mount();
    // Establish an authenticated demo session first (reseed requires token+user).
    await act(async () => {
      await ctx.signInDemo('demo@navixy.io', 'admin', 'iot-url', 'user-url');
    });
    vi.mocked(demoStorageService.seedFromBackend).mockClear();

    await act(async () => {
      await ctx.reseedDemoData();
    });
    expect(demoStorageService.seedFromBackend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      expect.any(Function),
    );

    const isStale = vi.mocked(demoStorageService.seedFromBackend).mock.calls[0][1] as () => boolean;
    expect(isStale()).toBe(false);
    await act(async () => {
      await ctx.signOut();
    });
    expect(isStale()).toBe(true);
  });
});

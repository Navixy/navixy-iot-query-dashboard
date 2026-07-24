/**
 * @vitest-environment jsdom
 *
 * Cross-tab tenant isolation via the storage-event ender (review !62 round 8,
 * finding 1). localStorage.auth_token is ORIGIN-WIDE: a sign-in/out in another
 * tab overwrites it while this tab's epoch and user never move, so this tab's
 * chat GET/reconcile/poll/status would fetch the successor's data under this
 * identity. When the shared token diverges from the one THIS tab authenticated
 * with, the tab ends its own session and redirects — WITHOUT clearing the
 * successor's token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext';
import { endAuthSession } from '@/lib/authSession';

const navigateMock = vi.fn();
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
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));

function stubFetch() {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith('/api/auth/login')) {
      return {
        ok: true,
        json: async () => ({
          success: true, token: 'demo-token',
          user: { id: 'u1', email: 'demo@navixy.io', role: 'admin' },
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ sections: [], reports: [], variables: [], catalog: null, data: [] }) } as Response;
  }) as unknown as typeof fetch;
}

let ctx: { signInDemo: ReturnType<typeof useAuth>['signInDemo']; user: ReturnType<typeof useAuth>['user'] };
function Grab() {
  const c = useAuth();
  ctx = { signInDemo: c.signInDemo, user: c.user };
  return null;
}
const CREDS = ['demo@navixy.io', 'admin', 'iot-url', 'user-url'] as const;

beforeEach(() => {
  localStorage.clear();
  endAuthSession();
  vi.clearAllMocks();
  stubFetch();
});
afterEach(() => cleanup());

async function signedInTab() {
  render(createElement(AuthProvider, null, createElement(Grab)));
  await act(async () => {
    await ctx.signInDemo(...CREDS); // anchors the tab to 'demo-token'
  });
  expect(ctx.user).not.toBeNull();
}

function fireStorage(key: string, newValue: string | null) {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
  });
}

describe('storage-event stale-tab ender (round 8, finding 1)', () => {
  it('ends the session and redirects when another tab writes a DIFFERENT token', async () => {
    await signedInTab();
    // Another tab signs in as a different tenant, overwriting the shared token.
    localStorage.setItem('auth_token', 'successor-token');
    fireStorage('auth_token', 'successor-token');

    expect(ctx.user).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith('/login');
    // The successor's token is UNTOUCHED — the ender must not sign them out.
    expect(localStorage.getItem('auth_token')).toBe('successor-token');
  });

  it('ends the session when another tab signs OUT (token removed)', async () => {
    await signedInTab();
    fireStorage('auth_token', null);
    expect(ctx.user).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith('/login');
  });

  it('ignores storage events for other keys', async () => {
    await signedInTab();
    navigateMock.mockClear();
    fireStorage('some_other_key', 'whatever');
    expect(ctx.user).not.toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

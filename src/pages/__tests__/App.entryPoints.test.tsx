/**
 * @vitest-environment jsdom
 *
 * !65 review round 3 — the two doors into the AI assistant, pinned.
 *
 * These two controls are the app's only visible way INTO the AI assistant.
 *
 * Stated precisely, because the first draft of this docstring overclaimed and !65
 * round 4 caught it: `/app/chat` appears in `src/App.tsx`'s route table and in
 * five comments, but `src/pages/App.tsx`'s CTA is the only thing a user can click
 * to reach it. `/app` is navigated to from seven places — post-login redirect,
 * `Login`, `SqlEditor`, both composite-report pages — but the sidebar Home link is
 * the only affordance for it that is on screen while a report is open, which is
 * where a user actually needs it.
 *
 * So: the primary navigation affordances, not the only references.
 *
 * The two failure modes are NOT the same, which round 5 pointed out after round 4's
 * fix flattened them into one sentence:
 *
 *   - **break the CTA** and `/app/chat` is reachable from the URL bar alone. It is
 *     the single clickable route in.
 *   - **break Home** and the assistant is still reachable — a login or auth
 *     redirect lands on `/app`, where the CTA is waiting. What is lost is getting
 *     BACK to `/app` from an open report without the browser's back button, which
 *     is the ordinary case rather than a dead end.
 *
 * Either way it happens with a green typecheck, a green lint and every other test
 * passing — nothing else in the repo would notice, which is what makes these
 * assertions worth their cost.
 *
 * Both cases pin the load-bearing DETAIL rather than mere presence, because in
 * this file every regression so far has been of the shape "the element is there
 * and does nothing":
 *
 *   - the CTA must be a real ANCHOR carrying the href. A <button> with a
 *     navigate() handler passes any "is it in the document" check while
 *     silently swallowing cmd-click and middle-click.
 *   - Home must survive MenuEditor's ERROR branch. That is the stated reason it
 *     lives in SidebarHeader instead of SidebarContent, it was verified by hand
 *     (M26) exactly once, and nothing stops a future refactor from tidying it
 *     inside the block it was deliberately kept out of.
 *   - the active row must carry a class that EMITS. Round 3 found the primitive's
 *     own `data-[active=true]:bg-sidebar-accent` compiling to nothing — this repo
 *     has no `sidebar` colour key — so `data-active` was set and no pixel changed.
 *     Asserting the class is as close to paint as jsdom gets; it is deliberately
 *     the token class and not the data attribute, because the data attribute was
 *     what passed last time.
 *
 * Real here: App, AppSidebar, MenuEditor (so its error branch is the real one),
 * the Card/Button/Sidebar primitives and the router. Mocked: the app shell around
 * the page, auth, and the menu query — none is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/AppSidebar';
import AppPage from '@/pages/App';

const authState = vi.hoisted(() => ({
  current: { user: { id: 'u1' } as unknown, loading: false, demoMode: false },
}));

const menuState = vi.hoisted(() => ({
  tree: { data: undefined as unknown, isLoading: false, error: null as Error | null },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

vi.mock('@/components/layout/AppLayout', () => ({
  // The shell (header, sidebar, menu queries) is not what the page case is about.
  AppLayout: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

// PARTIAL, on purpose: only the read is stubbed. MenuEditor mounts MenuModals,
// which pulls in half a dozen further mutation hooks — enumerating them here
// would make this file fail the next time one is added, for a reason that has
// nothing to do with what it asserts. The real ones need only a QueryClient.
vi.mock('@/hooks/use-menu-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-menu-mutations')>()),
  useMenuTree: () => menuState.tree,
}));

beforeEach(() => {
  authState.current = { user: { id: 'u1' }, loading: false, demoMode: false };
  menuState.tree = { data: undefined, isLoading: false, error: null };
  // jsdom ships no matchMedia; useIsMobile calls it on mount. innerWidth is 1024
  // here, so the Sidebar takes its desktop branch — the one the offset applies to.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderSidebarAt = (pathname: string) =>
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: [pathname] },
        createElement(SidebarProvider, null, createElement(AppSidebar)),
      ),
    ),
  );

describe('the getting-started chooser', () => {
  it('routes to /app/chat through a real anchor, not a click handler', () => {
    render(
      createElement(MemoryRouter, { initialEntries: ['/app'] }, createElement(AppPage)),
    );

    const cta = screen.getByRole('link', { name: /start chatting/i });
    expect(cta.tagName).toBe('A');
    expect(cta.getAttribute('href')).toBe('/app/chat');
  });
});

describe('the sidebar Home affordance', () => {
  it('still renders when the menu query has failed', () => {
    menuState.tree = { data: undefined, isLoading: false, error: new Error('menu tree 500') };

    renderSidebarAt('/app');

    // Prove we really are in MenuEditor's error branch — otherwise this case
    // would pass just as well against a menu that rendered fine.
    expect(screen.getByText(/failed to load the menu/i)).toBeTruthy();

    const home = screen.getByRole('link', { name: /home/i });
    expect(home.getAttribute('href')).toBe('/app');
  });

  it('paints the active row with a class this repo actually emits', () => {
    renderSidebarAt('/app');

    const home = screen.getByRole('link', { name: /home/i });
    expect(home.className).toContain('bg-accent-soft');
    expect(home.getAttribute('aria-current')).toBe('page');
  });

  it('does not mark Home active on a report route', () => {
    renderSidebarAt('/app/report/abc');

    const home = screen.getByRole('link', { name: /home/i });
    expect(home.className).not.toContain('bg-accent-soft');
    expect(home.getAttribute('aria-current')).toBeNull();
  });
});

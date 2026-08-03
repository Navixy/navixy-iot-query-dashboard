/**
 * @vitest-environment jsdom
 *
 * The result card's two controls, driven through a REAL render.
 *
 * `resultCardState` pins the RULE; this pins the WIRING of it — which button
 * carries which state, which one stays available, what a disabled Apply tells
 * the user, and whether the editor store is actually cleared before a preview
 * mounts. None of that is reachable from the pure function, and the wiring is
 * where a role gate usually breaks.
 *
 * It also covers the half of M14 that cannot be run by hand any more: since the
 * login response started carrying `effectiveRole`, the login form's role
 * selector cannot downgrade an account whose stored role is `admin`, so a live
 * viewer session needs an account we do not have. A rendered viewer does.
 *
 * Real here: resultCardState, the Button and Tooltip primitives, the editor
 * store (so the reset is observed rather than assumed), the router. Mocked: the
 * preview dialog (it mounts DashboardRenderer — Recharts, Leaflet, a
 * ResizeObserver and real SQL, none of it under test), the apply orchestration
 * (its own suite), the report mutation and the auth context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useEffect, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEditorStore } from '@/layout/state/editorStore';
import type { Dashboard } from '@/types/dashboard-types';
import type { AgentChatResult } from '@/types/agent';

const authState = vi.hoisted(() => ({
  current: { user: null as { id: string; email: string; role: string } | null },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

vi.mock('@/hooks/use-menu-mutations', () => ({
  useCreateReportMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../applyDashboard', () => ({
  applyDashboard: vi.fn(),
}));

/** What the editor store held when the dialog rendered, and when its effects ran —
 *  the two moments a real DashboardRenderer would read it (it prefers the store over
 *  its `dashboard` prop and re-seeds it on mount). Recording both is what makes the
 *  ordering assertion below an ordering assertion rather than an end-state one. */
const dialogReads = vi.hoisted(() => ({
  onRender: [] as Array<{ open: boolean; dashboard: unknown }>,
  onEffect: [] as Array<{ open: boolean; dashboard: unknown }>,
}));

/** Records what the card hands the dialog, and renders the Apply control the
 *  card passed down — the "one element, two placements" claim, checkable. */
vi.mock('../PreviewDialog', () => ({
  PreviewDialog: ({ open, nonce, applyAction }: {
    open: boolean; nonce: number; applyAction?: ReactNode;
  }) => {
    dialogReads.onRender.push({ open, dashboard: useEditorStore.getState().dashboard });
    useEffect(() => {
      dialogReads.onEffect.push({ open, dashboard: useEditorStore.getState().dashboard });
    });
    return createElement(
      'div',
      { 'data-testid': 'preview-dialog', 'data-open': String(open), 'data-nonce': String(nonce) },
      open ? applyAction : null,
    );
  },
}));

const { applyDashboard } = await import('../applyDashboard');
const { ResultCard } = await import('../ResultCard');

// Radix's popper measures its content with a ResizeObserver, which jsdom has not.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

const result: AgentChatResult = {
  title: 'Driver Mileage — Last 30 Days',
  report_schema: { title: 'Driver Mileage — Last 30 Days', panels: [{ id: 1 }, { id: 2 }] },
};

function mount(over: { role?: string | null; canApply?: boolean; isPending?: boolean } = {}) {
  const role = over.role === undefined ? 'editor' : over.role;
  authState.current.user = role === null
    ? null
    : { id: 'u1', email: 'u@example.com', role };
  const canApply = over.canApply ?? (role === 'admin' || role === 'editor');
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(
        TooltipProvider,
        // Focus opens a Radix tooltip immediately; the delay only governs hover.
        { delayDuration: 0 },
        createElement(ResultCard, { result, canApply, isPending: over.isPending ?? false }),
      ),
    ),
  );
}

const previewButton = () => screen.getByRole('button', { name: 'Preview' });
const applyButtons = () => screen.getAllByRole('button', { name: 'Apply' });
const applyButton = () => applyButtons()[0];

beforeEach(() => {
  vi.clearAllMocks();
  // `applyDashboard` is `async`, so it ALWAYS returns a promise — a bare vi.fn()
  // returning undefined is not a faithful stand-in for it, and the card now attaches
  // its backstop .catch to what comes back.
  vi.mocked(applyDashboard).mockResolvedValue(undefined);
  useEditorStore.getState().reset();
  dialogReads.onRender.length = 0;
  dialogReads.onEffect.length = 0;
});

afterEach(() => {
  cleanup();
  authState.current.user = null;
});

describe('ResultCard', () => {
  it('shows the dashboard title and its panel count', () => {
    mount();
    expect(screen.getByText('Driver Mileage — Last 30 Days')).toBeTruthy();
    expect(screen.getByText('2 panels')).toBeTruthy();
  });

  it('says "1 panel" for a single-panel dashboard', () => {
    authState.current.user = { id: 'u1', email: 'u@example.com', role: 'editor' };
    render(createElement(MemoryRouter, null, createElement(TooltipProvider, null,
      createElement(ResultCard, {
        result: { title: 'One', report_schema: { panels: [{ id: 1 }] } },
        canApply: true, isPending: false,
      }))));
    expect(screen.getByText('1 panel')).toBeTruthy();
  });

  it('lets an editor apply', () => {
    mount({ role: 'editor' });
    expect(applyButton().disabled).toBe(false);
    expect(previewButton().disabled).toBe(false);
  });

  it('refuses a viewer the Apply button but never the Preview button', () => {
    mount({ role: 'viewer' });
    expect(applyButton().disabled).toBe(true);
    expect(previewButton().disabled).toBe(false);

    fireEvent.click(applyButton());
    expect(applyDashboard).not.toHaveBeenCalled();
  });

  it('tells a viewer why, on the disabled button', async () => {
    mount({ role: 'viewer' });
    // A disabled button fires no pointer events, so the tooltip hangs off the
    // wrapper span — focus it the way a keyboard user reaches it.
    fireEvent.focus(applyButton().parentElement as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByText('Ask an editor to create this dashboard').length).toBeGreaterThan(0);
    });
  });

  it('still refuses a viewer even when the page says they may apply', async () => {
    // The mirror of the AND test below, and the one that proves the CARD reads the
    // role itself instead of trusting a prop that could drift out of step with it.
    mount({ role: 'viewer', canApply: true });
    expect(applyButton().disabled).toBe(true);

    fireEvent.focus(applyButton().parentElement as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByText('Ask an editor to create this dashboard').length).toBeGreaterThan(0);
    });
  });

  it('shows no tooltip at all while Apply is available', async () => {
    // The other half of the rule: a reason is offered exactly when there is one.
    mount({ role: 'admin' });
    fireEvent.focus(applyButton().parentElement as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryByText('Ask an editor to create this dashboard')).toBeNull();
    expect(screen.queryByText('Wait for the current reply to finish')).toBeNull();
  });

  it('refuses Apply while a chat turn is in flight, and says so', async () => {
    mount({ role: 'admin', isPending: true });
    expect(applyButton().disabled).toBe(true);
    expect(previewButton().disabled).toBe(false);

    fireEvent.focus(applyButton().parentElement as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByText('Wait for the current reply to finish').length).toBeGreaterThan(0);
    });
  });

  it('refuses Apply when the role is not known yet', () => {
    mount({ role: null, canApply: false });
    expect(applyButton().disabled).toBe(true);
  });

  it('refuses Apply when the page says no even if the local role says yes', () => {
    // The two reads are ANDed on purpose: if they ever disagree, the safer one wins.
    mount({ role: 'admin', canApply: false });
    expect(applyButton().disabled).toBe(true);
  });

  it('hands the apply over once, and disables the button until it settles', async () => {
    mount({ role: 'editor' });
    fireEvent.click(applyButton());

    expect(applyDashboard).toHaveBeenCalledTimes(1);
    const args = vi.mocked(applyDashboard).mock.calls[0][0];
    expect(args.result).toBe(result);
    expect(typeof args.navigate).toBe('function');
    expect(typeof args.onSettled).toBe('function');

    await waitFor(() => expect(applyButton().disabled).toBe(true));
    // A second click while it runs must not start a second apply.
    fireEvent.click(applyButton());
    expect(applyDashboard).toHaveBeenCalledTimes(1);

    args.onSettled();
    await waitFor(() => expect(applyButton().disabled).toBe(false));
  });

  it('brings Apply back when the apply throws instead of settling', async () => {
    // onSettled is how every KNOWN failure re-enables the button. An unexpected throw
    // reaches none of them: without a .catch at the call site the rejection is
    // unhandled, isApplying stays true, and Apply sits disabled behind "Creating the
    // dashboard..." until the page is reloaded. (!64 review round 5, finding 1)
    vi.mocked(applyDashboard).mockRejectedValueOnce(new Error('unexpected'));
    mount({ role: 'editor' });

    fireEvent.click(applyButton());
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    // ...and it is a working button again, not merely an enabled one.
    fireEvent.click(applyButton());
    expect(applyDashboard).toHaveBeenCalledTimes(2);
  });

  it('resets the editor store BEFORE the preview opens', () => {
    // Hazard 1: the store is a module singleton and DashboardRenderer prefers it
    // over its prop, so a leftover dashboard would be painted instead of this one.
    //
    // The ORDERING is the claim, not just the end state. A reset moved into an effect
    // keyed on `open` leaves the store empty by the time anything asserts on it, and
    // would still blank the renderer in production — child effects run before parent
    // effects, so the reset would land after the renderer had seeded the store. So
    // this asserts on what the dialog could observe at the two moments a real
    // renderer reads the store: its own render, and its own effect.
    useEditorStore.setState({
      dashboard: { title: 'Someone else', panels: [], time: { from: '', to: '' } } as Dashboard,
      isEditingLayout: true,
      selectedPanelId: 'p9',
    });
    mount({ role: 'editor' });
    expect(screen.getByTestId('preview-dialog').dataset.open).toBe('false');

    fireEvent.click(previewButton());

    const openingRender = dialogReads.onRender.find((read) => read.open);
    const openingEffect = dialogReads.onEffect.find((read) => read.open);
    expect(openingRender).toBeDefined();
    expect(openingEffect).toBeDefined();
    expect(openingRender?.dashboard).toBeNull();
    expect(openingEffect?.dashboard).toBeNull();

    expect(useEditorStore.getState().dashboard).toBeNull();
    expect(useEditorStore.getState().isEditingLayout).toBe(false);
    expect(useEditorStore.getState().selectedPanelId).toBeNull();
    expect(screen.getByTestId('preview-dialog').dataset.open).toBe('true');
  });

  it('gives every opening a fresh renderer instance', () => {
    mount({ role: 'editor' });
    const nonce = () => screen.getByTestId('preview-dialog').dataset.nonce;
    const first = nonce();
    fireEvent.click(previewButton());
    const second = nonce();
    fireEvent.click(previewButton());

    expect(second).not.toBe(first);
    expect(nonce()).not.toBe(second);
  });

  it('puts the same Apply control in the dialog, carrying the same state', () => {
    mount({ role: 'viewer' });
    expect(applyButtons()).toHaveLength(1);

    fireEvent.click(previewButton());

    const both = applyButtons();
    expect(both).toHaveLength(2);
    // The footer copy is not a second implementation: it is disabled for the same
    // reason, without the dialog knowing what the reason is.
    expect(both.every((b) => b.disabled)).toBe(true);
    expect(screen.getByTestId('preview-dialog').contains(both[1])).toBe(true);
  });

  it('applies from the dialog footer too', () => {
    mount({ role: 'admin' });
    fireEvent.click(previewButton());

    const footerApply = applyButtons()[1];
    expect(footerApply.disabled).toBe(false);
    fireEvent.click(footerApply);
    expect(applyDashboard).toHaveBeenCalledTimes(1);
  });
});

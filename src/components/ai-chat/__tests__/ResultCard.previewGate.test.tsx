/**
 * @vitest-environment jsdom
 *
 * The preview gate, driven end to end: a REAL `ResultCard`, a REAL `PreviewDialog` and
 * a REAL `DashboardRenderer`, with only the network, the datetime prefs, `ParameterBar`
 * and `Canvas` stubbed.
 *
 * `ResultCard.test.tsx` covers the same gate through a mocked dialog, which is the
 * right level for the card's own wiring — and is exactly why it could not see round 7's
 * defect. That one lives in the seam between three components: the renderer re-emits
 * its CURRENT status whenever `onPanelStatusChange`'s identity changes (it is in that
 * effect's deps), so a card handed a different result while a preview was open could
 * take the OLD dashboard's terminal status and file it under the NEW schema. A mocked
 * dialog emits when the test tells it to; only the real one emits when React does.
 *
 * The two schemas below deliberately share panel ids. Agent artifacts number panels
 * 1..N, so a stale count is not merely stale — the new dashboard's panels find the old
 * dashboard's data by id and the status looks TERMINAL rather than empty, which is what
 * makes this unlock Apply instead of just flickering. (!64 review round 7, finding 1)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEditorStore } from '@/layout/state/editorStore';
import type { AgentChatResult } from '@/types/agent';

const authState = vi.hoisted(() => ({
  current: { user: { id: 'u1', email: 'u@example.com', role: 'editor' } as { id: string; email: string; role: string } | null },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState.current }));
vi.mock('@/hooks/use-menu-mutations', () => ({
  useCreateReportMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../applyDashboard', () => ({ applyDashboard: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/services/api', () => ({
  apiService: { executeSQL: vi.fn(), getGlobalVariables: vi.fn() },
}));

vi.mock('@/contexts/DatetimePrefsContext', () => ({
  useDatetimePrefs: () => ({
    prefs: { timezone: 'UTC', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' },
  }),
}));

vi.mock('@/components/reports/ParameterBar', () => ({
  ParameterBar: () => createElement('div', { 'data-testid': 'parameter-bar' }),
}));

vi.mock('@/layout/ui/Canvas', () => ({
  Canvas: () => createElement('div', { 'data-testid': 'layout-canvas' }),
}));

const { apiService } = await import('@/services/api');
const { ResultCard } = await import('../ResultCard');
const executeSQL = vi.mocked(apiService.executeSQL);
const getGlobalVariables = vi.mocked(apiService.getGlobalVariables);

/** PanelGrid measures itself; Radix's popper does too. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const sqlPanel = (id: number, statement: string) => ({
  id,
  type: 'table',
  title: `P${id}`,
  gridPos: { x: 0, y: 0, w: 12, h: 6 },
  'x-navixy': { sql: { statement } },
});

/** SAME panel ids in both, on purpose — see the file docblock. */
const schemaA = {
  title: 'A', time: { from: 'now-24h', to: 'now' },
  panels: [sqlPanel(1, 'SELECT a FROM one'), sqlPanel(2, 'SELECT b FROM two')],
};
const schemaB = {
  title: 'B', time: { from: 'now-24h', to: 'now' },
  panels: [sqlPanel(1, 'SELECT c FROM three'), sqlPanel(2, 'SELECT d FROM four')],
};

const resultA: AgentChatResult = { title: 'A', report_schema: schemaA };
const resultB: AgentChatResult = { title: 'B', report_schema: schemaB };

const tree = (result: AgentChatResult) =>
  createElement(MemoryRouter, null,
    createElement(TooltipProvider, { delayDuration: 0 },
      createElement(ResultCard, { result, canApply: true, isPending: false })));

const applyButton = () => screen.getAllByRole('button', { name: 'Apply' })[0];
const previewButton = () => screen.getByRole('button', { name: 'Preview' });

/** Statements the renderer has actually sent, newest last. */
const sent = () => executeSQL.mock.calls.map(([body]) => (body as { sql: string }).sql);

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  useEditorStore.getState().reset();
  getGlobalVariables.mockResolvedValue({ data: [] });
  executeSQL.mockImplementation(() =>
    Promise.resolve({ data: { columns: [{ name: 'x' }], rows: [{ x: 1 }] } }) as never);
});

describe('the preview gate, through the real renderer', () => {
  it('unlocks Apply only once the real panels have executed', async () => {
    render(tree(resultA));
    expect(applyButton().disabled).toBe(true);

    fireEvent.click(previewButton());
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    expect(sent()).toContain('SELECT a FROM one');
    expect(sent()).toContain('SELECT b FROM two');
  });

  it('re-locks Apply when the card is handed a different result mid-preview', async () => {
    // THE REGRESSION. Before the fix: swapping the schema changed the identity of the
    // completion callback, the still-mounted renderer re-emitted schema A's terminal
    // status, and the card filed it under schema B — so Apply stayed enabled for a
    // dashboard whose SQL had not run. With ids shared between the schemas, B's panels
    // even found A's data, so the count read terminal rather than empty.
    const view = render(tree(resultA));
    fireEvent.click(previewButton());
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    // Nothing of B has executed at the moment of the swap.
    executeSQL.mockClear();
    view.rerender(tree(resultB));

    // Synchronously, in the very first committed frame: the run is invalidated in
    // render, so no effect gets the chance to unlock on A's evidence.
    expect(applyButton().disabled).toBe(true);

    await waitFor(() => expect(applyButton().disabled).toBe(false));
    expect(sent()).toContain('SELECT c FROM three');
    expect(sent()).toContain('SELECT d FROM four');
  });

  it('stays locked while the new schema is still executing, not merely for a tick', async () => {
    // EVERY query is held, not just the last one — one resolver per panel. A single
    // shared resolver leaves the other panel pending for ever, which looks like the
    // gate working and is really the harness failing to let go.
    const held: Array<(value: unknown) => void> = [];
    const view = render(tree(resultA));
    fireEvent.click(previewButton());
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    executeSQL.mockImplementation(() =>
      new Promise((resolve) => { held.push(resolve); }) as never);
    view.rerender(tree(resultB));

    expect(applyButton().disabled).toBe(true);
    // Give every pending effect and microtask a chance to unlock it wrongly.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(applyButton().disabled).toBe(true);
    expect(held.length).toBeGreaterThan(0);

    // Drained in waves: the query loop awaits each panel before starting the next, so
    // releasing the held promises mints the following one.
    const rows = { data: { columns: [{ name: 'x' }], rows: [{ x: 1 }] } };
    for (let wave = 0; wave < 10 && applyButton().disabled; wave += 1) {
      await act(async () => { held.splice(0).forEach((resolve) => resolve(rows)); });
    }
    expect(applyButton().disabled).toBe(false);
  });

  it('does not unlock a result that was never previewed, even after another one was', async () => {
    // The same claim from the other side: a card that completes a preview for A and is
    // then handed B must treat B as unproven, not inherit A's proof.
    const view = render(tree(resultA));
    fireEvent.click(previewButton());
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    // Close the dialog first, so nothing is mounted to execute B at all.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    view.rerender(tree(resultB));

    expect(applyButton().disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(applyButton().disabled).toBe(true);
  });
});

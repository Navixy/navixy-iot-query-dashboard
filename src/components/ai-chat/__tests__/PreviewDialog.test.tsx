/**
 * @vitest-environment jsdom
 *
 * What the preview hands the renderer.
 *
 * The dialog's RENDERING is deliberately not tested — mounting the real
 * DashboardRenderer would mean stubbing Recharts, Leaflet, `apiService`,
 * ResizeObserver and the editor store, producing a test that asserts the mock. Its
 * PROP WIRING is a different question, and it is the one !64 review round 3 found
 * broken: the preview ran with `globalVariables` defaulting to `[]` while the applied
 * report runs with the user's real ones, so a dashboard binding a global could fail in
 * the preview and work after Apply. A banner that lies about that defeats the dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AgentChatResult } from '@/types/agent';

const rendererProps = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('@/components/reports/DashboardRenderer', () => ({
  DashboardRenderer: (props: Record<string, unknown>) => {
    rendererProps.calls.push(props);
    return createElement('div', { 'data-testid': 'renderer' });
  },
}));

vi.mock('@/services/api', () => ({
  apiService: { getGlobalVariables: vi.fn() },
}));

const { apiService } = await import('@/services/api');
const { PreviewDialog } = await import('../PreviewDialog');
const getGlobalVariables = vi.mocked(apiService.getGlobalVariables);

const result: AgentChatResult = {
  title: 'Driver Mileage',
  report_schema: { title: 'Driver Mileage', panels: [{ id: 1, type: 'table' }], refresh: '5m' },
};

const globals = [{ label: 'fleet_id', value: '42' }];

function mount(over: Partial<{ result: AgentChatResult }> = {}) {
  return render(createElement(PreviewDialog, {
    result: over.result ?? result,
    open: true,
    onOpenChange: () => {},
    nonce: 1,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  rendererProps.calls.length = 0;
  getGlobalVariables.mockResolvedValue({ data: globals });
});

afterEach(cleanup);

describe('PreviewDialog', () => {
  it('renders with the user`s global variables, the way the report view does', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());

    expect(getGlobalVariables).toHaveBeenCalledTimes(1);
    expect(rendererProps.calls.at(-1)?.globalVariables).toEqual(globals);
  });

  it('does not execute a single panel before the globals have settled', async () => {
    // Mounting first would run every query with nothing bound, paint failures, and
    // then re-run — the banner would announce a failure that never existed.
    let release: (value: { data: unknown }) => void = () => {};
    getGlobalVariables.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    mount();
    expect(screen.queryByTestId('renderer')).toBeNull();
    expect(rendererProps.calls).toHaveLength(0);

    await act(async () => { release({ data: globals }); });
    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());
    expect(rendererProps.calls.at(-1)?.globalVariables).toEqual(globals);
  });

  it('still previews when the globals cannot be read, exactly as the report view does', async () => {
    getGlobalVariables.mockRejectedValue(new Error('offline'));
    mount();

    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());
    expect(rendererProps.calls.at(-1)?.globalVariables).toEqual([]);
  });

  it('tolerates a payload that is not an array', async () => {
    getGlobalVariables.mockResolvedValue({ data: undefined });
    mount();

    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());
    expect(rendererProps.calls.at(-1)?.globalVariables).toEqual([]);
  });

  it('hands the renderer a dashboard with no auto-refresh', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());

    const dashboard = rendererProps.calls.at(-1)?.dashboard as Record<string, unknown>;
    expect('refresh' in dashboard).toBe(false);
    expect(dashboard.panels).toEqual(result.report_schema.panels);
  });

  it('mounts no renderer at all when the schema cannot be read as a dashboard', async () => {
    mount({ result: { title: 'Broken', report_schema: { nope: true } } });

    await waitFor(() => {
      expect(screen.getByText(/could not be read as a dashboard/i)).toBeTruthy();
    });
    expect(rendererProps.calls).toHaveLength(0);
    // ...and no panel banner beside it to contradict the message.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

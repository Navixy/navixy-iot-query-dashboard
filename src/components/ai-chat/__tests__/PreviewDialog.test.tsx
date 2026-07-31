/**
 * @vitest-environment jsdom
 *
 * What the preview hands the renderer, and what it tells the user back.
 *
 * The renderer is a stub here on purpose — the real one is exercised in
 * DashboardRenderer.panelStatus.test.tsx, which is where a claim about panel counting
 * belongs. What this file owns is the seam between them, in both directions:
 *
 * - OUT, the props. Round 3 found the preview running with `globalVariables`
 *   defaulting to `[]` while the applied report runs with the user's real ones, so a
 *   dashboard binding a global could fail here and work after Apply.
 * - BACK, the banner. Round 4 found nothing holding `onPanelStatusChange` in place:
 *   dropping it left the header on "Loading panels…" forever with every test green.
 *
 * Both failures are the same failure — a preview that reports something other than
 * what applying would produce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { PanelLoadStatus } from '@/components/reports/panelLoadStatus';
import type { AgentChatResult } from '@/types/agent';

const rendererProps = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  /** What the stub renderer reports through `onPanelStatusChange`; null = silent. */
  status: null as PanelLoadStatus | null,
}));

vi.mock('@/components/reports/DashboardRenderer', () => ({
  DashboardRenderer: (props: Record<string, unknown>) => {
    rendererProps.calls.push(props);
    const report = props.onPanelStatusChange as ((status: PanelLoadStatus) => void) | undefined;
    // From an effect, as the real renderer does — reporting during render would be a
    // parent setState mid-child-render.
    useEffect(() => {
      if (rendererProps.status) report?.(rendererProps.status);
    }, [report]);
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
  rendererProps.status = null;
  getGlobalVariables.mockResolvedValue({ data: globals });
});

afterEach(cleanup);

const banner = () => screen.getByRole('status');

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

  it('keeps its parameters out of the chat page`s URL', async () => {
    // /app/chat owns no parameters and never clears them, so preview A's time window
    // would be read back by preview B and executed instead of B's own `time`.
    mount();
    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());

    expect(rendererProps.calls.at(-1)?.syncParametersToUrl).toBe(false);
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

/**
 * The banner is the reason this dialog exists: a preview the user does not read as
 * "one of these panels is broken" is a preview that did not do its job. Deleting
 * `onPanelStatusChange={handleStatus}` left every other test in the repo green while
 * the header sat on "Loading panels..." forever. (!64 review round 4, finding 1)
 */
describe('PreviewDialog — the panel banner', () => {
  const withStatus = async (status: PanelLoadStatus) => {
    rendererProps.status = status;
    mount();
    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());
    await waitFor(() => expect(banner().textContent).not.toMatch(/Loading panels/));
  };

  it('says only that it is loading until the renderer has reported anything', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());

    // NOT "this dashboard has no data panels" — nobody has counted yet.
    expect(banner().textContent).toContain('Loading panels');
  });

  it('names the failure count, and marks it, when a panel does not load', async () => {
    await withStatus({ total: 2, loaded: 1, failed: 1, pending: 0 });

    expect(banner().textContent)
      .toBe('1 of 2 panels loaded. 1 panel failed — check it before applying.');
    expect(banner().className).toContain('text-destructive');
  });

  it('pluralises the failures, since "1 panel failed" about three is a lie', async () => {
    await withStatus({ total: 5, loaded: 2, failed: 3, pending: 0 });

    expect(banner().textContent)
      .toBe('2 of 5 panels loaded. 3 panels failed — check them before applying.');
  });

  it('says everything loaded, without the destructive treatment', async () => {
    await withStatus({ total: 11, loaded: 11, failed: 0, pending: 0 });

    expect(banner().textContent).toBe('All 11 panels loaded.');
    expect(banner().className).not.toContain('text-destructive');
  });

  it('states one panel population, never two that disagree', async () => {
    // Every agent dashboard ships a text panel, so the raw schema count and the count
    // of panels that run SQL always differ. The header used to print both, two lines
    // apart: "3 panels, previewed against your data." above "All 2 panels loaded."
    rendererProps.status = { total: 2, loaded: 2, failed: 0, pending: 0 };
    mount({
      result: {
        title: 'T',
        report_schema: {
          panels: [{ id: 1, type: 'text' }, { id: 2, type: 'table' }, { id: 3, type: 'table' }],
        },
      },
    });
    await waitFor(() => expect(banner().textContent).toBe('All 2 panels loaded.'));

    const subtitle = screen.getByText(/previewed against your data/i);
    expect(subtitle.textContent).not.toMatch(/\d/);
  });

  it('counts down while panels are still executing', async () => {
    rendererProps.status = { total: 4, loaded: 1, failed: 0, pending: 3 };
    mount();

    await waitFor(() => expect(banner().textContent).toBe('Loading 3 panels…'));
  });
});

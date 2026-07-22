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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function mount(over: Partial<{
  result: AgentChatResult;
  onPreviewComplete: (status: PanelLoadStatus) => void;
}> = {}) {
  return render(createElement(PreviewDialog, {
    result: over.result ?? result,
    open: true,
    onOpenChange: () => {},
    nonce: 1,
    ...(over.onPreviewComplete ? { onPreviewComplete: over.onPreviewComplete } : {}),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  rendererProps.calls.length = 0;
  rendererProps.status = null;
  getGlobalVariables.mockResolvedValue({ data: globals });
});

afterEach(cleanup);

/**
 * The banner is three nodes: a styled row, the visible sentence inside it (aria-hidden,
 * because it counts down), and the sr-only live region that carries the accessible
 * copy. `getByRole('status')` finds the live region; the other two hang off it.
 */
const announced = () => screen.getByRole('status').textContent;
const banner = () => screen.getByRole('status').previousElementSibling as HTMLElement;
const bannerRow = () => screen.getByRole('status').parentElement as HTMLElement;

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

  it('treats a successful empty list as globals, because that is what it is', async () => {
    getGlobalVariables.mockResolvedValue({ data: [] });
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
      expect(screen.getByText(/failed to read this result as a dashboard/i)).toBeTruthy();
    });
    expect(rendererProps.calls).toHaveLength(0);
    // ...and no panel banner beside it to contradict the message.
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/**
 * A preview that could not run in the user's context has not previewed anything.
 *
 * This used to collapse a rejection, an `error` payload and a wrong-shaped body into
 * `[]` and carry on — copying ReportView's fail-silent shape, which is right for a page
 * that RENDERS a report and wrong for a dialog that makes a CLAIM about one. ReportView
 * re-reads globals after Apply and can succeed, so the applied dashboard would bind
 * values this preview never saw. (!64 review round 6, finding 2)
 */
describe('PreviewDialog — when the globals cannot be read', () => {
  const failures: Array<[string, () => void]> = [
    ['the request rejects', () => getGlobalVariables.mockRejectedValue(new Error('offline'))],
    // The API client reports failure in the BODY, not by rejecting — so this path
    // resolved, and `data` being undefined then read as "no globals".
    ['the response carries an error', () =>
      getGlobalVariables.mockResolvedValue({ error: { code: 'DB', message: 'down' } })],
    ['the payload is not a list', () => getGlobalVariables.mockResolvedValue({ data: undefined })],
  ];

  for (const [name, arrange] of failures) {
    it(`executes nothing and says so when ${name}`, async () => {
      arrange();
      mount();

      await waitFor(() => {
        expect(screen.getByText(/failed to read your global variables/i)).toBeTruthy();
      });
      // The important half: no renderer, so not one statement ran.
      expect(screen.queryByTestId('renderer')).toBeNull();
      expect(rendererProps.calls).toHaveLength(0);
      // ...and no banner beside the message to contradict it with a panel count.
      expect(screen.queryByRole('status')).toBeNull();
    });
  }

  it('never reports a preview as complete, so Apply stays locked', async () => {
    const onPreviewComplete = vi.fn();
    getGlobalVariables.mockRejectedValue(new Error('offline'));
    mount({ onPreviewComplete });

    await waitFor(() => {
      expect(screen.getByText(/failed to read your global variables/i)).toBeTruthy();
    });
    expect(onPreviewComplete).not.toHaveBeenCalled();
  });

  it('retries in place, because the alternative is reopening the dialog', async () => {
    getGlobalVariables.mockRejectedValueOnce(new Error('offline'));
    mount();
    await waitFor(() => {
      expect(screen.getByText(/failed to read your global variables/i)).toBeTruthy();
    });

    getGlobalVariables.mockResolvedValue({ data: globals });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.queryByTestId('renderer')).not.toBeNull());
    expect(rendererProps.calls.at(-1)?.globalVariables).toEqual(globals);
    expect(screen.queryByText(/failed to read your global variables/i)).toBeNull();
  });
});

/**
 * What unlocks Apply. The dialog is the feature's only correctness control (R27), so
 * "the preview finished" has to mean the dashboard was EXECUTED — not that the dialog
 * was opened. (!64 review round 6, finding 1)
 */
describe('PreviewDialog — reporting a finished preview', () => {
  it('reports the terminal status, and not the pending ones before it', async () => {
    const onPreviewComplete = vi.fn();
    rendererProps.status = { total: 2, loaded: 1, failed: 1, pending: 0, unverifiable: 0 };
    mount({ onPreviewComplete });

    await waitFor(() => expect(onPreviewComplete).toHaveBeenCalledTimes(1));
    // ...and it says WHICH dashboard finished. The caller cannot infer that from its
    // own props at the moment the call arrives — that assumption is what let a stale
    // terminal status unlock a schema nobody had executed. (round 7, finding 1)
    expect(onPreviewComplete).toHaveBeenCalledWith(
      { total: 2, loaded: 1, failed: 1, pending: 0, unverifiable: 0 },
      result.report_schema);
  });

  it('stays silent while panels are still executing', async () => {
    const onPreviewComplete = vi.fn();
    rendererProps.status = { total: 4, loaded: 1, failed: 0, pending: 3, unverifiable: 0 };
    mount({ onPreviewComplete });

    await waitFor(() => expect(banner().textContent).toBe('Loading panels: 3…'));
    expect(onPreviewComplete).not.toHaveBeenCalled();
  });

  it('reports a dashboard whose panels all failed — an execution IS evidence', async () => {
    // Failed panels do not block Apply; the user may save 9 of 10 and fix the last in
    // the layout editor. What the gate requires is that the execution happened.
    const onPreviewComplete = vi.fn();
    rendererProps.status = { total: 2, loaded: 0, failed: 2, pending: 0, unverifiable: 0 };
    mount({ onPreviewComplete });

    await waitFor(() => expect(onPreviewComplete).toHaveBeenCalledTimes(1));
  });

  it('never reports when the schema cannot be read as a dashboard', async () => {
    const onPreviewComplete = vi.fn();
    mount({ result: { title: 'Broken', report_schema: { nope: true } }, onPreviewComplete });

    await waitFor(() => {
      expect(screen.getByText(/failed to read this result as a dashboard/i)).toBeTruthy();
    });
    expect(onPreviewComplete).not.toHaveBeenCalled();
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
    await withStatus({ total: 2, loaded: 1, failed: 1, pending: 0, unverifiable: 0 });

    expect(banner().textContent)
      .toBe('Panels loaded: 1 of 2. Failed panels: 1. Check them before applying.');
    expect(bannerRow().className).toContain('text-destructive');
  });

  it('names a larger failure count just as plainly', async () => {
    await withStatus({ total: 5, loaded: 2, failed: 3, pending: 0, unverifiable: 0 });

    expect(banner().textContent)
      .toBe('Panels loaded: 2 of 5. Failed panels: 3. Check them before applying.');
  });

  it('says everything loaded, without the destructive treatment', async () => {
    await withStatus({ total: 11, loaded: 11, failed: 0, pending: 0, unverifiable: 0 });

    expect(banner().textContent).toBe('All panels loaded: 11.');
    expect(bannerRow().className).not.toContain('text-destructive');
  });

  it('states one panel population, never two that disagree', async () => {
    // Every agent dashboard ships a text panel, so the raw schema count and the count
    // of panels that run SQL always differ. The header used to print both, two lines
    // apart: "3 panels, previewed against your data." above "All 2 panels loaded."
    rendererProps.status = { total: 2, loaded: 2, failed: 0, pending: 0, unverifiable: 0 };
    mount({
      result: {
        title: 'T',
        report_schema: {
          panels: [{ id: 1, type: 'text' }, { id: 2, type: 'table' }, { id: 3, type: 'table' }],
        },
      },
    });
    await waitFor(() => expect(banner().textContent).toBe('All panels loaded: 2.'));

    const subtitle = screen.getByText(/previewed against your data/i);
    expect(subtitle.textContent).not.toMatch(/\d/);
  });

  it('counts down while panels are still executing', async () => {
    rendererProps.status = { total: 4, loaded: 1, failed: 0, pending: 3, unverifiable: 0 };
    mount();

    await waitFor(() => expect(banner().textContent).toBe('Loading panels: 3…'));
  });

  it('announces the outcome, not one line per panel', async () => {
    // Panels execute sequentially, so the visible sentence changes once per panel.
    // A live region carrying it reads "Loading panels: 11…", "Loading panels: 10…",
    // eleven times over. (!64 review round 4, finding 9)
    rendererProps.status = { total: 4, loaded: 1, failed: 0, pending: 3, unverifiable: 0 };
    mount();

    await waitFor(() => expect(banner().textContent).toBe('Loading panels: 3…'));
    expect(announced()).toBe('Loading panels…');
  });

  it('announces the terminal state through a region that was there all along', async () => {
    // A region only added — or only made polite — at the moment its text changes is
    // not reliably read out.
    await withStatus({ total: 2, loaded: 1, failed: 1, pending: 0, unverifiable: 0 });

    expect(announced()).toBe('Panels loaded: 1 of 2. Failed panels: 1. Check them before applying.');
  });
});

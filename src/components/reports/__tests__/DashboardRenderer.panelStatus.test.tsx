/**
 * @vitest-environment jsdom
 *
 * The renderer half of the preview banner: that `onPanelStatusChange` reports what
 * actually happened, and that `syncParametersToUrl` reaches `ParameterBar`.
 *
 * `panelLoadStatus.test.ts` proves the arithmetic and `previewStatusText.test.ts`
 * proves the copy; nothing proved the RENDERER feeds either of them. That gap hid a
 * real defect: the query loop sets one `newPanelData` object, mutates it as each query
 * lands, then sets the same object again — so a `useMemo` keyed on its identity kept
 * returning the all-pending snapshot and the banner never left "Loading N panels…".
 * Every other test stayed green. (!64 review round 4, finding 1)
 *
 * The renderer mounts for real here — only the network, the datetime prefs,
 * `ParameterBar` and `Canvas` are stubbed — which is why it can catch that at all.
 *
 * The renderer has TWO ParameterBar call sites, one per top-level branch, and both are
 * mounted below: covering only the one the preview happens to use left the other free
 * to lose the prop silently. (round 5, finding 5)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEditorStore } from '@/layout/state/editorStore';
import type { PanelLoadStatus } from '../panelLoadStatus';

const bar = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock('@/components/reports/ParameterBar', () => ({
  ParameterBar: (props: Record<string, unknown>) => {
    bar.props.push(props);
    return createElement('div', { 'data-testid': 'parameter-bar' });
  },
}));

vi.mock('@/services/api', () => ({ apiService: { executeSQL: vi.fn() } }));

/** Only so the layout-editor branch has something cheap to render; @dnd-kit and the
 *  whole editor are someone else's suite. */
vi.mock('@/layout/ui/Canvas', () => ({
  Canvas: () => createElement('div', { 'data-testid': 'layout-canvas' }),
}));

vi.mock('@/contexts/DatetimePrefsContext', () => ({
  useDatetimePrefs: () => ({
    prefs: { timezone: 'UTC', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' },
  }),
}));

const { apiService } = await import('@/services/api');
const executeSQL = vi.mocked(apiService.executeSQL);
const { DashboardRenderer } = await import('../DashboardRenderer');

/** PanelGrid measures itself; jsdom has no ResizeObserver. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

/**
 * Stable identity, and that is not incidental: `globalVariables` defaults to a fresh
 * `[]`, which feeds the query effect's dependencies, so an inline literal re-runs the
 * effect on every render and no query ever settles. Both production call sites hold it
 * in state.
 */
const GLOBALS: Array<{ label: string; value: string }> = [];

const sqlPanel = (id: number, statement: string) => ({
  id,
  type: 'table',
  title: `P${id}`,
  gridPos: { x: 0, y: 0, w: 12, h: 6 },
  'x-navixy': { sql: { statement } },
});

const textPanel = (id: number) => ({
  id,
  type: 'text',
  title: 'Attention',
  gridPos: { x: 0, y: 0, w: 24, h: 3 },
  options: { mode: 'text', content: 'AI-generated' },
});

const dashboardWith = (panels: unknown[]) => ({
  title: 'D',
  time: { from: 'now-24h', to: 'now' },
  panels,
});

function mount(panels: unknown[], over: {
  syncParametersToUrl?: boolean; editMode?: boolean;
} = {}) {
  const seen: PanelLoadStatus[] = [];
  render(createElement(MemoryRouter, null,
    createElement(DashboardRenderer, {
      dashboard: dashboardWith(panels),
      globalVariables: GLOBALS,
      onPanelStatusChange: (status: PanelLoadStatus) => seen.push(status),
      ...over,
    } as never)));
  return seen;
}

const settled = async (seen: PanelLoadStatus[]) => {
  await waitFor(() => expect(seen.at(-1)?.pending).toBe(0));
  return seen.at(-1) as PanelLoadStatus;
};

beforeEach(() => {
  vi.clearAllMocks();
  bar.props.length = 0;
  cleanup();
  // `displayDashboard` prefers the editor store over the prop whenever the store is
  // hydrated, and the store is a module singleton — without this, one test renders the
  // previous test's dashboard. Production resets it for the same reason (PreviewDialog
  // does it on open and on close).
  useEditorStore.getState().reset();
  executeSQL.mockImplementation((body: { sql: string }) =>
    (body.sql.includes('nope')
      ? Promise.resolve({ error: { code: '42703', message: 'column "nope" does not exist' } })
      : Promise.resolve({ data: { columns: [{ name: 'a' }], rows: [{ a: 1 }] } })) as never);
});

describe('DashboardRenderer → onPanelStatusChange', () => {
  it('reaches a terminal count that separates the panel that loaded from the one that failed', async () => {
    const seen = mount([sqlPanel(1, 'SELECT 1 AS a'), sqlPanel(2, 'SELECT nope FROM t')]);

    expect(await settled(seen)).toEqual({ total: 2, loaded: 1, failed: 1, pending: 0, unverifiable: 0 });
  });

  it('starts by reporting every SQL panel as pending, so the banner can say so', async () => {
    const seen = mount([sqlPanel(1, 'SELECT 1 AS a')]);

    expect(seen[0]).toEqual({ total: 1, loaded: 0, failed: 0, pending: 1, unverifiable: 0 });
    await settled(seen);
  });

  it('counts only the panels the query loop actually executes', async () => {
    // The text panel every agent dashboard ships, plus a panel with no statement.
    // Neither is queried — but only the text panel may vanish from the banner's
    // numbers, because only the text panel is doing what it is supposed to do.
    const seen = mount([
      textPanel(9),
      { id: 8, type: 'table', title: 'No SQL', gridPos: { x: 0, y: 0, w: 12, h: 6 } },
      sqlPanel(1, 'SELECT 1 AS a'),
    ]);

    // The statement-less panel is REPORTED, not dropped: it renders a "No SQL
    // configured" placeholder and Apply would save it. (round 6, finding 3)
    expect(await settled(seen))
      .toEqual({ total: 1, loaded: 1, failed: 0, pending: 0, unverifiable: 1 });
    // ...and the loop agrees: nothing but the one statement was ever sent.
    for (const [body] of executeSQL.mock.calls) {
      expect((body as { sql: string }).sql).toBe('SELECT 1 AS a');
    }
  });

  it('reports every panel failing when every query does', async () => {
    const seen = mount([sqlPanel(1, 'SELECT nope FROM a'), sqlPanel(2, 'SELECT nope FROM b')]);

    expect(await settled(seen)).toEqual({ total: 2, loaded: 0, failed: 2, pending: 0, unverifiable: 0 });
  });
});

describe('DashboardRenderer → ParameterBar', () => {
  it('forwards syncParametersToUrl=false, so a preview cannot write to the page URL', async () => {
    const seen = mount([sqlPanel(1, 'SELECT 1 AS a')], { syncParametersToUrl: false });
    await settled(seen);

    expect(bar.props.length).toBeGreaterThan(0);
    expect(bar.props.every((props) => props.syncParametersToUrl === false)).toBe(true);
  });

  it('defaults to true, so a report at its own URL keeps sharing its filters', async () => {
    const seen = mount([sqlPanel(1, 'SELECT 1 AS a')]);
    await settled(seen);

    expect(bar.props.length).toBeGreaterThan(0);
    expect(bar.props.every((props) => props.syncParametersToUrl === true)).toBe(true);
  });

  it('forwards it from the LAYOUT EDITOR branch too, which renders its own bar', async () => {
    // There are two ParameterBar call sites — the Canvas branch and the grid branch —
    // and the view-mode tests above only ever reach the second, so deleting the prop
    // from the first left the whole suite green. Inert today (edit mode is only
    // reachable at a report's own URL, where the default is already true), which is
    // exactly why nothing else would notice it going missing.
    // (!64 review round 5, finding 5)
    useEditorStore.getState().setIsEditingLayout(true);
    const seen = mount([sqlPanel(1, 'SELECT 1 AS a')], {
      editMode: true, syncParametersToUrl: false,
    });
    await settled(seen);

    expect(screen.getByTestId('layout-canvas')).toBeTruthy();
    expect(bar.props.length).toBeGreaterThan(0);
    expect(bar.props.every((props) => props.syncParametersToUrl === false)).toBe(true);
  });
});

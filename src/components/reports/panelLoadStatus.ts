/**
 * Aggregate per-panel query status for a mounted DashboardRenderer.
 *
 * The arithmetic lives here rather than inline in DashboardRenderer.tsx so it can
 * be unit-tested: importing the renderer pulls Recharts, Leaflet, `apiService` and
 * the editor store, none of which load in this repo's `node` Vitest environment
 * (vitest.config.ts). The renderer owns the state; this module owns the counting.
 *
 * Added for the AI chat preview (DO-313). See the `onPanelStatusChange` prop.
 */
import type { Panel } from '@/types/dashboard-types';

/**
 * The subset of the renderer's private `PanelData` entry this counter reads.
 * Structural, so `PanelData` stays assignable without exporting it.
 */
export interface PanelQueryState {
  data: unknown;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

/** Keyed by `String(panel.id)`, exactly as the renderer keys its state. */
export type PanelQueryStates = Record<string, PanelQueryState | undefined>;

/** Exported so the preview dialog can type its state without redeclaring the shape. */
export interface PanelLoadStatus {
  /** SQL-bearing panels. Text/SQL-less panels are excluded. */
  total: number;
  /** Panels holding data and no error. */
  loaded: number;
  /** Panels whose last query attempt threw. */
  failed: number;
  /** Panels still loading or refreshing. `total - loaded - failed` is not reliable
   *  mid-refresh, when a panel can hold stale data AND be refreshing. */
  pending: number;
}

/**
 * Count SQL-bearing panels by the state of their last query attempt.
 *
 * Counts describe what is on screen right now, not history: a panel that failed and
 * was then refreshed successfully moves from `failed` back to `loaded`.
 *
 * `panels` is the renderer's flat, already-normalized panel list — row children have
 * been hoisted into it by `normalizeDashboardForRender`, so nested children are
 * counted. Row headers are `type: 'row'` and carry no SQL, so the `hasSql` guard
 * excludes them without a special case.
 */
export function computePanelLoadStatus(
  panels: Panel[],
  panelData: PanelQueryStates,
): PanelLoadStatus {
  let total = 0;
  let loaded = 0;
  let failed = 0;
  let pending = 0;

  panels.forEach((panel) => {
    const navixyConfig = panel['x-navixy'];
    const hasSql = !!navixyConfig?.sql?.statement?.trim();
    // The same predicate the renderer's query loop uses to decide what to execute.
    if (panel.type === 'text' || !hasSql) return;
    total += 1;

    const state = panelData[String(panel.id)];
    if (!state) {
      pending += 1;
      return;
    }
    // ERROR IS TESTED BEFORE DATA, AND THAT ORDERING IS LOAD-BEARING, NOT STYLISTIC.
    // The bulk query loop's failure path preserves `data: existingData?.data || null`
    // when it sets `error`, so a panel that held data and then failed a re-run (auto
    // refresh, a parameter change, a timezone change) holds stale data AND an error
    // simultaneously. Any design keyed on `data === null` would count it as `loaded`.
    // (The single-panel `refreshPanel` failure path clears `data`; the bulk path is
    // the one that produces the overlap.)
    if (state.error) failed += 1;
    else if (state.loading || state.refreshing) pending += 1;
    else if (state.data) loaded += 1;
    else pending += 1;
  });

  return { total, loaded, failed, pending };
}

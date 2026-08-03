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
  /**
   * Non-text panels the query loop will NEVER execute, and which therefore cannot be
   * counted, failed or waited for — but which a saved dashboard still contains.
   *
   * Two sources, both of which used to make a panel vanish from every number here:
   * a **blank or absent statement** (the backend validator passes it as a warning, and
   * the renderer paints "No SQL configured"), and a **collapsed row's children**, which
   * live in `row.panels[]` rather than the top-level list the loop walks.
   *
   * They are separated from `failed` because they are not failures — nothing was tried.
   * They must not fold into `pending` either: nothing is coming, so a consumer that
   * waits on `pending === 0` would wait forever. (!64 review round 6, finding 3)
   */
  unverifiable: number;
}

/**
 * Count SQL-bearing panels by the state of their last query attempt.
 *
 * Counts describe what is on screen right now, not history: a panel that failed and
 * was then refreshed successfully moves from `failed` back to `loaded`.
 *
 * `panels` must be the renderer's `displayDashboard.panels` — the SAME list its query
 * loop walks. That, and not any property of the list itself, is what makes the count
 * trustworthy: whatever is in it gets executed, and nothing else does.
 *
 * It is worth being exact about that list, because an earlier version of this comment
 * was not. `canonicalizeRows` does not hoist row children up into it. An EXPANDED
 * row's children were always top-level in the Grafana shape (it empties `row.panels`
 * to match), and a COLLAPSED row's children are moved the other way — down into
 * `row.panels[]` and out of the top-level list. (!64 review round 4, finding 7)
 *
 * **"The same answer on both sides" is not good enough, which round 4 missed.** Agreeing
 * with the query loop makes the count HONEST about what ran; it does not make the
 * PREVIEW honest, because the preview is a claim about the dashboard that will be
 * SAVED — and a collapsed row's children are saved. Counting them as `unverifiable` is
 * what stops "All 3 panels loaded." being said over two statements nobody executed.
 * `toPreviewDashboard` expands rows before mounting, so that arm should be unreachable
 * from the preview; it is counted anyway, because the day it is not is the day the
 * banner would go back to lying silently. (!64 review round 6, finding 3)
 */
export function computePanelLoadStatus(
  panels: Panel[],
  panelData: PanelQueryStates,
): PanelLoadStatus {
  let total = 0;
  let loaded = 0;
  let failed = 0;
  let pending = 0;
  let unverifiable = 0;

  panels.forEach((panel) => {
    if (panel.type === 'row') {
      // Row HEADERS carry no SQL and are not panels in this sense. Their children are:
      // present here only while the row is collapsed, and never executed.
      (panel.panels ?? []).forEach((child) => {
        if (child.type === 'row' || child.type === 'text') return;
        unverifiable += 1;
      });
      return;
    }
    if (panel.type === 'text') return;

    const navixyConfig = panel['x-navixy'];
    const hasSql = !!navixyConfig?.sql?.statement?.trim();
    // The same predicate the renderer's query loop uses to decide what to execute —
    // but a data panel it declines to run is now COUNTED rather than dropped. Fixture
    // 05 ships a "New barchart" with `"statement": ""`, the backend validator passes it
    // as a warning, and it renders as a "No SQL configured" placeholder. Excluding it
    // turned a dashboard whose only data panel was blank into "This dashboard has no
    // data panels." — a sentence about the preview, read as a sentence about the
    // dashboard being saved.
    if (!hasSql) {
      unverifiable += 1;
      return;
    }
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

  return { total, loaded, failed, pending, unverifiable };
}

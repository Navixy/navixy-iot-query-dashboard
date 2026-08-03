/**
 * How the agent's schema becomes the dashboard the preview mounts.
 *
 * Pure and separate from `PreviewDialog` so it is testable in the `node`
 * environment — importing the dialog pulls DashboardRenderer, and with it
 * Recharts and Leaflet. (DO-313)
 */
import type { Dashboard } from '@/types/dashboard-types';
import { isRowPanel, toggleRowCollapsed } from '@/layout/geometry/rows';
import { normalizeToDashboard } from '@/types/schema-conversions';

/**
 * Expand every collapsed row, so the preview EXECUTES the whole dashboard.
 *
 * A collapsed row keeps its children in `row.panels[]` and out of the top-level list
 * (`rows.ts` canonicalization), and the renderer's query loop walks only the top-level
 * list — so those panels were saved by Apply without ever having been run, under a
 * banner that said "All N panels loaded" about the ones that had. The preview is the
 * feature's only correctness control (R27); a control that skips part of its subject is
 * not one. (!64 review round 6, finding 3)
 *
 * `toggleRowCollapsed` is the editor's own expand, so the relative→absolute y maths and
 * the canonicalization are the ones the layout editor uses rather than a second
 * implementation. A row with no `id` cannot be addressed and is left alone; its children
 * stay counted as `unverifiable`, which is the honest answer rather than a silent one.
 *
 * The SAVED schema is untouched — Apply serializes `result.report_schema`, collapse
 * state included. What changes is only how much of it this dialog runs.
 */
function expandCollapsedRows(dashboard: Dashboard): Dashboard {
  const collapsedIds = dashboard.panels
    .filter((panel) => isRowPanel(panel) && panel.collapsed === true && panel.id != null)
    .map((panel) => panel.id as string | number);

  if (collapsedIds.length === 0) return dashboard;

  // CLONED FIRST, and this is not defensive tidiness — `toggleRowCollapsed` mutates its
  // input. It copies panels with a shallow spread (`{ ...p }`), so `panel.gridPos` is
  // still the CALLER's object, and the relative→absolute y rewrite lands on it. Without
  // this the preview would edit `result.report_schema` in place and Apply would save a
  // dashboard whose collapsed children had silently moved — the exact opposite of
  // "the saved bytes are the previewed bytes", introduced by the fix meant to make the
  // preview honest. Caught by this file's own does-not-mutate test.
  //
  // Deliberately NOT fixed in rows.ts here: that shared mutation is the layout editor's
  // (its undo stack holds references to the same gridPos objects), it predates this MR,
  // and a geometry change belongs in its own change with its own suite. Reported instead.
  const clone = JSON.parse(JSON.stringify(dashboard)) as Dashboard;

  return collapsedIds.reduce(
    (acc, id) => toggleRowCollapsed(acc, id, false),
    clone,
  );
}

/**
 * Read the agent's `report_schema` as a Dashboard, with auto-refresh removed.
 *
 * `normalizeToDashboard` decides membership purely on shape and returns null only
 * when neither the object nor `.dashboard` carries a `panels` array. Server-side
 * `validateDashboard` already rejected that, so null here means a contract break
 * upstream, not bad user input.
 *
 * **Why `refresh` is dropped.** The agent ships `"refresh": "5m"` (see the vendored
 * artifact), and DashboardRenderer honours it whenever it is not in edit mode: a
 * preview left open would silently re-execute every agent statement against the
 * real iotDbUrl on a timer. That contradicts the rule this whole surface rests on —
 * preview is user-initiated, so the DB load is bounded by deliberate clicks (R-LOAD)
 * — and the re-run also flips the failure banner back through "Loading N panels…",
 * momentarily hiding the count that is the point of the dialog.
 *
 * **What ReportView does here that this does not.** It migrates a `rows`-shaped legacy
 * schema through `ReportMigration.migrateToGrafana` before normalizing, and it treats
 * `panels.length === 0` as an error rather than a dashboard. Neither is reachable from
 * the agent, which emits Grafana-shaped `panels` and is rejected upstream by
 * `validateDashboard` otherwise — a rows-shaped schema fails the null check below and
 * the dialog says so, which is honest rather than wrong. It is recorded because it is
 * the same class as round 3's globals defect: the preview and the applied report
 * running the same dashboard through different preparation. Before adding a prop OR a
 * TRANSFORM to ReportView's renderer, ask whether the preview needs it too.
 * (!64 review round 4, finding 8)
 *
 * **This does not weaken "the saved bytes are the previewed bytes".** Apply saves
 * `result.report_schema` untouched, `refresh` and collapse state included; what is
 * changed here is a re-execution cadence and how much of the dashboard is on screen at
 * once — never a panel, a statement or a coordinate. Everything the
 * preview exists to validate is rendered from the agent's own bytes. A SAVED
 * dashboard should keep auto-refreshing — that is what a dashboard is for.
 */
export function toPreviewDashboard(schema: unknown): Dashboard | null {
  const normalized = normalizeToDashboard(schema);
  if (!normalized) return null;

  const dashboard = expandCollapsedRows(normalized);
  if (dashboard.refresh === undefined) return dashboard;

  const { refresh: _dropped, ...withoutRefresh } = dashboard;
  return withoutRefresh as Dashboard;
}

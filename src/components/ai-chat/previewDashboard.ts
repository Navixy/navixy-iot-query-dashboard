/**
 * How the agent's schema becomes the dashboard the preview mounts.
 *
 * Pure and separate from `PreviewDialog` so it is testable in the `node`
 * environment — importing the dialog pulls DashboardRenderer, and with it
 * Recharts and Leaflet. (DO-313)
 */
import type { Dashboard } from '@/types/dashboard-types';
import { normalizeToDashboard } from '@/types/schema-conversions';

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
 * **This does not weaken "the saved bytes are the previewed bytes".** Apply saves
 * `result.report_schema` untouched, `refresh` included; what is dropped here is a
 * re-execution cadence, never a panel, a statement or a coordinate. Everything the
 * preview exists to validate is rendered from the agent's own bytes. A SAVED
 * dashboard should keep auto-refreshing — that is what a dashboard is for.
 */
export function toPreviewDashboard(schema: unknown): Dashboard | null {
  const dashboard = normalizeToDashboard(schema);
  if (!dashboard) return null;
  if (dashboard.refresh === undefined) return dashboard;

  const { refresh: _dropped, ...withoutRefresh } = dashboard;
  return withoutRefresh as Dashboard;
}

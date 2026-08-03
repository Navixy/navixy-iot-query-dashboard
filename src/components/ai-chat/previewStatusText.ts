/**
 * The preview banner's copy and severity, decided from the renderer's panel counts.
 *
 * Pure and separate from the dialog so it is testable in the `node` environment, and
 * so the one string a user must not miss — "K panels failed" — is pinned by tests
 * rather than by a screenshot. (DO-313)
 */
import type { PanelLoadStatus } from '@/components/reports/panelLoadStatus';

export type PanelStatusSeverity = 'muted' | 'destructive';

export interface PanelStatusDescription {
  text: string;
  severity: PanelStatusSeverity;
  /** True while panels are still executing — the banner shows a spinner. */
  busy: boolean;
}

const panels = (n: number) => (n === 1 ? 'panel' : 'panels');

/**
 * @param status the renderer's latest counts, or `null` before it has reported any.
 *
 * The null case is not the same as `{total: 0}` and must not be folded into it: the
 * renderer emits its first status from a passive effect, so an all-zero initial state
 * would have the banner announce "This dashboard has no data panels" about a
 * dashboard nobody has counted yet — briefly on every preview, and permanently on the
 * one path where no renderer ever mounts.
 */
export function describePanelStatus(status: PanelLoadStatus | null): PanelStatusDescription {
  if (!status) {
    return { text: 'Loading panels…', severity: 'muted', busy: true };
  }

  const { total, loaded, failed, pending, unverifiable } = status;

  if (total === 0 && unverifiable === 0) {
    return { text: 'This dashboard has no data panels.', severity: 'muted', busy: false };
  }

  // Loading wins over a partial failure count: mid-load the count is not final, and
  // every panel settles (each query writes either data or an error), so a failure
  // cannot hide here permanently — it surfaces the moment the last panel lands.
  // The unverifiable clause waits with it: nothing about it changes, and a countdown
  // is hard enough to read without a second number beside it.
  if (pending > 0) {
    return { text: `Loading ${pending} ${panels(pending)}…`, severity: 'muted', busy: true };
  }

  // "N panels were not checked" is DESTRUCTIVE for the same reason a failure is: the
  // preview is the only thing that can tell the user whether this dashboard works, and
  // for those panels it did not run. Saying it quietly would be the old behaviour of
  // dropping them, one shade lighter. (!64 review round 6, finding 3)
  const notChecked = unverifiable > 0
    ? `${unverifiable} ${panels(unverifiable)} could not be checked — ` +
      `${unverifiable === 1 ? 'it has' : 'they have'} no SQL to run.`
    : '';

  if (total === 0) {
    return { text: notChecked, severity: 'destructive', busy: false };
  }

  const severity: PanelStatusSeverity =
    failed > 0 || unverifiable > 0 ? 'destructive' : 'muted';

  const base = failed > 0
    ? `${loaded} of ${total} ${panels(total)} loaded. ` +
      `${failed} ${panels(failed)} failed — check ${failed === 1 ? 'it' : 'them'} before applying.`
    : total === 1 ? '1 panel loaded.' : `All ${total} panels loaded.`;

  return { text: notChecked ? `${base} ${notChecked}` : base, severity, busy: false };
}

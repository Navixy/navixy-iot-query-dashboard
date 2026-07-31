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

export function describePanelStatus(status: PanelLoadStatus): PanelStatusDescription {
  const { total, loaded, failed, pending } = status;

  if (total === 0) {
    return { text: 'This dashboard has no data panels.', severity: 'muted', busy: false };
  }

  // Loading wins over a partial failure count: mid-load the count is not final, and
  // every panel settles (each query writes either data or an error), so a failure
  // cannot hide here permanently — it surfaces the moment the last panel lands.
  if (pending > 0) {
    return { text: `Loading ${pending} ${panels(pending)}…`, severity: 'muted', busy: true };
  }

  if (failed > 0) {
    return {
      text:
        `${loaded} of ${total} ${panels(total)} loaded. ` +
        `${failed} ${panels(failed)} failed — check ${failed === 1 ? 'it' : 'them'} before applying.`,
      severity: 'destructive',
      busy: false,
    };
  }

  return {
    text: total === 1 ? '1 panel loaded.' : `All ${total} panels loaded.`,
    severity: 'muted',
    busy: false,
  };
}

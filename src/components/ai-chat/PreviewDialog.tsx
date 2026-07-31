import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { DashboardRenderer } from '@/components/reports/DashboardRenderer';
import type { PanelLoadStatus } from '@/components/reports/panelLoadStatus';
import { useEditorStore } from '@/layout/state/editorStore';
import type { AgentChatResult } from '@/types/agent';
import { toPreviewDashboard } from './previewDashboard';
import { describePanelStatus } from './previewStatusText';

interface PreviewDialogProps {
  result: AgentChatResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bumped by the opener so each preview mounts a fresh renderer instance. */
  nonce: number;
  /**
   * The card's own Apply control, rendered a second time in the footer so the
   * decision can be taken where the evidence is. One element, two placements —
   * never a second implementation of the enablement rules.
   */
  applyAction?: ReactNode;
}

/**
 * Preview an agent-generated dashboard against the user's real data.
 *
 * This dialog IS the feature's correctness control. DashboardRenderer self-fetches
 * every panel's SQL through /api/sql-new/execute, so opening it executes the agent's
 * statements against the real iotDbUrl. Static validation cannot do this: the real
 * agent's first dashboard passed the SELECT-only guard on all three statements and
 * one still failed at the database with `42703 column o.employee_id does not exist`.
 * `validateDashboard` is a SAFETY gate, never a CORRECTNESS gate — it answers "can
 * this dashboard hurt us or fail to render", not "is this dashboard right". Only the
 * preview answers the second question, so it must never become skippable: no "apply
 * directly", no "don't show this again", no auto-apply on a result turn. (DO-313, R27)
 */
export function PreviewDialog({ result, open, onOpenChange, nonce, applyAction }: PreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Sizing is load-bearing, not cosmetic. ui/dialog.tsx gives DialogContent no
          max-height and no overflow, PanelGrid computes an absolute pixel height from
          the layout, and the shell is `h-svh overflow-hidden` with <main> as the sole
          scroll container (FR-11509) — so a preview taller than the viewport would have
          no scrollbar anywhere. The body div below owns the overflow; putting it on
          DialogContent instead would scroll the failure banner out of view AND
          reintroduce the Radix scrollbar-shift blink FR-11509 fixed.
          `flex` beats the primitive's `grid`, `p-0` beats `p-6` and `max-w-[95vw]`
          beats `max-w-lg` because cn() is twMerge(clsx(...)) (src/lib/utils.ts).
          `svh`, not `vh`: the whole FR-11509 lineage is `h-svh`. */}
      <DialogContent className="max-w-[95vw] w-[95vw] h-[90svh] p-0 flex flex-col">
        {/* Radix unmounts closed content once its exit animation ends, so the body —
            and the store cleanup below — is scoped to one open/close cycle. The renderer
            therefore outlives `open` by the ~200 ms fade; that cannot overlap a second
            renderer, because the modal overlay is still up and swallows the click that
            would open another preview. */}
        <PreviewBody result={result} nonce={nonce} applyAction={applyAction} />
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ result, nonce, applyAction }: {
  result: AgentChatResult; nonce: number; applyAction?: ReactNode;
}) {
  // null until the renderer reports — NOT {0,0,0,0}, which reads as "this dashboard
  // has no data panels" and would be the first thing every preview says.
  const [status, setStatus] = useState<PanelLoadStatus | null>(null);

  // Stable identity: DashboardRenderer emits from an effect keyed on the counts, so
  // an unstable handler would re-fire it on every render.
  const handleStatus = useCallback((next: PanelLoadStatus) => setStatus(next), []);

  // Drops the agent's `refresh: "5m"` — a preview is a one-shot validation, not a
  // live dashboard. See previewDashboard.ts for why, and for why this does not
  // weaken the "saved bytes are the previewed bytes" guarantee.
  const dashboard = useMemo(
    () => toPreviewDashboard(result.report_schema),
    [result.report_schema],
  );

  // Leaving the store populated would paint the next report view — or the next
  // preview — from this dashboard, and could leave it in layout-edit mode. The
  // opener resets on the way in; this resets on the way out. Both are needed:
  // the opener's reset is what a second preview relies on, this one is what the
  // rest of the app relies on.
  useEffect(() => () => useEditorStore.getState().reset(), []);

  const banner = describePanelStatus(status);
  const panelCount = Array.isArray(result.report_schema['panels'])
    ? (result.report_schema['panels'] as unknown[]).length
    : 0;

  return (
    <>
      <DialogHeader className="shrink-0 p-4 pb-2">
        <DialogTitle className="text-left">{result.title}</DialogTitle>
        <DialogDescription className="text-left">
          {panelCount === 1 ? '1 panel' : `${panelCount} panels`}, previewed against your data.
        </DialogDescription>
        {/* The banner lives in the HEADER, which is shrink-0 and therefore visible
            however far the grid below is scrolled. A failure the user does not notice
            is the same as no preview at all.
            Suppressed entirely when the schema could not be read: no renderer mounts,
            so no count is ever coming, and a panel banner beside "this could not be
            read as a dashboard" only contradicts it. */}
        {dashboard && (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
              banner.severity === 'destructive'
                ? 'border border-destructive/30 bg-destructive/10 text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {banner.busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
            {banner.severity === 'destructive' && (
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>{banner.text}</span>
          </div>
        )}
      </DialogHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {dashboard ? (
          <DashboardRenderer
            key={nonce}
            dashboard={dashboard}
            onPanelStatusChange={handleStatus}
          />
        ) : (
          <p className="text-sm text-destructive">
            This result could not be read as a dashboard. Ask the assistant to rebuild it.
          </p>
        )}
      </div>

      <DialogFooter className="shrink-0 flex-col items-stretch gap-2 border-t p-4 pt-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Unconditional, and kept even though the live count shipped: the count says
            WHAT happened, this says why it matters. D17: results are cached for five
            minutes, but errors are never cached, so a failing preview always re-runs. */}
        <p className="text-left text-xs text-muted-foreground">
          AI-generated SQL can reference columns that do not exist. Check that each panel
          renders before applying. Data may be cached for up to 5 minutes.
        </p>
        {applyAction}
      </DialogFooter>
    </>
  );
}

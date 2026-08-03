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
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DashboardRenderer } from '@/components/reports/DashboardRenderer';
import type { PanelLoadStatus } from '@/components/reports/panelLoadStatus';
import { apiService } from '@/services/api';
import { useEditorStore } from '@/layout/state/editorStore';
import type { AgentChatResult } from '@/types/agent';
import { toPreviewDashboard } from './previewDashboard';
import { describePanelStatus } from './previewStatusText';

type GlobalVariable = { label: string; value: string; description?: string };

/** Loading and "could not be read" are DIFFERENT from "there are none" — see the
 *  comment on the fetch below for why collapsing them was a defect. */
type GlobalsState =
  | { status: 'loading' }
  | { status: 'ready'; vars: GlobalVariable[] }
  | { status: 'error' };

interface PreviewDialogProps {
  result: AgentChatResult;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bumped by the opener so each preview mounts a fresh renderer instance. */
  nonce: number;
  /**
   * Fired when the mounted renderer reaches a TERMINAL status — every panel has either
   * data or an error. This is what unlocks Apply (R27), so the three ways a preview can
   * end without proving anything all resolve to "never fired": the schema could not be
   * read (no renderer mounts), the globals could not be read (no renderer mounts), or
   * the user closed the dialog mid-execution. (!64 review round 6, finding 1)
   *
   * It carries the `report_schema` the run belongs to, because "a preview finished" is
   * not a useful fact on its own — the caller has to know WHICH dashboard finished, and
   * cannot infer it from its own props at the moment the call arrives.
   * (!64 review round 7, finding 1)
   */
  onPreviewComplete?: (status: PanelLoadStatus, schema: unknown) => void;
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
export function PreviewDialog({
  result, open, onOpenChange, nonce, applyAction, onPreviewComplete,
}: PreviewDialogProps) {
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
        <PreviewBody
          result={result}
          nonce={nonce}
          applyAction={applyAction}
          onPreviewComplete={onPreviewComplete}
        />
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ result, nonce, applyAction, onPreviewComplete }: {
  result: AgentChatResult;
  nonce: number;
  applyAction?: ReactNode;
  onPreviewComplete?: (status: PanelLoadStatus, schema: unknown) => void;
}) {
  // null until the renderer reports — NOT {0,0,0,0}, which reads as "this dashboard
  // has no data panels" and would be the first thing every preview says.
  const [status, setStatus] = useState<PanelLoadStatus | null>(null);

  // The preview must execute in the SAME context the applied report will.
  // `globalVariables` is one such input: ParameterBar merges them over declared
  // parameter defaults, and those defaults are the values the panel queries bind.
  // ReportView passes the user's real globals; a preview that defaulted to [] would
  // run a dashboard binding `:fleet_id` with nothing bound, fail, and report "1 panel
  // failed" about a dashboard that works the moment it is applied — or pass where the
  // applied report fails, if a global masks a bad declared default. Either way the
  // banner would be lying, which is the one thing this dialog exists not to do.
  // (!64 review round 3)
  //
  // A FAILED read is therefore not the same as "there are none", and this used to
  // collapse the two — reject, `response.error` and a wrong-shaped payload all became
  // `[]`, and the preview then executed and reported as if it had run in the user's
  // context. It had not: ReportView issues its own GET after Apply, which can succeed
  // and pick up the real overrides, so a preview that says "1 panel failed" (or
  // "All 3 loaded") after a five-second settings-DB blip is describing a dashboard
  // nobody will ever open. Copying ReportView's fail-silent shape was the mistake —
  // ReportView renders A report, while this dialog makes a CLAIM about one.
  // (!64 review round 6, finding 2)
  //
  // Re-read on every open, and that is a choice rather than an oversight. Radix unmounts
  // closed content, so this effect runs once per preview — and "refine, then re-preview"
  // is the documented workflow, which puts one small GET on the critical path each time.
  // Caching it would trade that for a preview binding a global the user edited in
  // Settings since, which is the round 3 defect again in a slower form: the preview and
  // the applied report running the same dashboard against different inputs. The dialog
  // then goes on to execute N statements against a remote Postgres; one round trip for
  // a guaranteed-current answer is the cheap half. If it ever does need caching, it
  // needs a query invalidated by the settings screen that writes these, not a memo.
  // (!64 review round 5, finding 6)
  const [globals, setGlobals] = useState<GlobalsState>({ status: 'loading' });
  // Bumped by Retry. A preview the user could not repair without closing and reopening
  // the dialog would push them straight back to the thing this state exists to prevent.
  const [globalsAttempt, setGlobalsAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setGlobals({ status: 'loading' });
    apiService.getGlobalVariables()
      .then((response) => {
        if (!alive) return;
        // An `error` payload is a failure even though the promise resolved — the API
        // client reports failure in the body, not by rejecting. An empty array is only
        // ever the SUCCESSFUL answer "this user has no globals".
        if (response.error || !Array.isArray(response.data)) {
          setGlobals({ status: 'error' });
          return;
        }
        setGlobals({ status: 'ready', vars: response.data as GlobalVariable[] });
      })
      .catch(() => { if (alive) setGlobals({ status: 'error' }); });
    return () => { alive = false; };
  }, [globalsAttempt]);

  // Stable identity: DashboardRenderer emits from an effect keyed on the counts, so
  // an unstable handler would re-fire it on every render.
  const handleStatus = useCallback((next: PanelLoadStatus) => {
    setStatus(next);
    // TERMINAL, not "first report": the renderer's opening emission has every panel
    // pending, and unlocking Apply on that would gate on the dialog having been
    // OPENED rather than on the dashboard having been EXECUTED — which is the same
    // hole in a smaller box. `unverifiable` is not part of the test: a panel with no
    // SQL never resolves, so waiting on it would lock Apply forever.
    // Reported WITH the schema this dashboard was built from, so the caller checks
    // rather than assumes. The two move together — the memo below shares this dep — so
    // a renderer mounted for schema A can never have its status filed under schema B.
    if (next.pending === 0) onPreviewComplete?.(next, result.report_schema);
  }, [onPreviewComplete, result.report_schema]);

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

  return (
    <>
      {/* pr-12 keeps a long agent title clear of DialogContent's own absolute close X
          (right-4 top-4), which p-0 on the content pulls right up against the text. */}
      <DialogHeader className="shrink-0 p-4 pb-2 pr-12">
        <DialogTitle className="text-left">{result.title}</DialogTitle>
        {/* NO panel count here. The banner below counts the panels that RUN SQL; a
            count taken from the raw schema counts the disclaimer text panel too, and
            every agent dashboard ships one — so the two numbers disagreed on every
            real preview, two lines apart ("3 panels, previewed against your data."
            above "All 2 panels loaded."). Both were true of different populations,
            which is not something a header can convey. The card the user came from
            already states the schema count. (!64 review round 4, finding 2) */}
        <DialogDescription className="text-left">
          Previewed against your data. Nothing is saved until you apply.
        </DialogDescription>
        {/* The banner lives in the HEADER, which is shrink-0 and therefore visible
            however far the grid below is scrolled. A failure the user does not notice
            is the same as no preview at all.
            Suppressed entirely when the schema could not be read, and equally when the
            globals could not be: in both cases no renderer mounts, so no count is ever
            coming, and a panel banner beside the explanation only contradicts it. */}
        {dashboard && globals.status !== 'error' && (
          <div
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
            {/* The visible copy counts DOWN as panels settle. aria-hidden because the
                live region beside it is the accessible copy of the same sentence. */}
            <span aria-hidden="true">{banner.text}</span>
            {/* One announcement per OUTCOME, not one per panel. Panels execute
                sequentially, so the visible text changes once per panel — a polite
                live region carrying it would read "Loading 11 panels…", "Loading 10
                panels…" eleven times over. This region is present and polite from the
                first render (flipping aria-live off→polite in the same commit as the
                text change is not reliably announced) and simply holds still while
                busy. (!64 review round 4, finding 9) */}
            <span role="status" aria-live="polite" className="sr-only">
              {banner.busy ? 'Loading panels…' : banner.text}
            </span>
          </div>
        )}
      </DialogHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {dashboard ? (
          globals.status === 'error' ? (
            // NOT a renderer with `[]`. Running here would execute every statement
            // with the wrong bindings and then report the result as if it were the
            // truth — and unlock Apply on the strength of it.
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-destructive">
                Your global variables could not be read, so this preview would not run
                the way the saved dashboard will. Nothing has been executed.
              </p>
              <Button variant="secondary" size="sm" onClick={() => setGlobalsAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : (
            // Mounted only once the globals are READY. Mounting first would execute
            // every panel once with no bindings, paint failures, then re-execute when
            // they arrive — the banner would announce a failure that was never real.
            globals.status === 'ready' && (
              <DashboardRenderer
                key={nonce}
                dashboard={dashboard}
                globalVariables={globals.vars}
                // /app/chat owns no parameters and never clears them, so a preview
                // writing its range there would hand it to the NEXT preview, which
                // would then execute with the previous dashboard's window.
                syncParametersToUrl={false}
                onPanelStatusChange={handleStatus}
              />
            )
          )
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

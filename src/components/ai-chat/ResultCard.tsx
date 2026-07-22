import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLocale } from '@/i18n/LocaleProvider';
import { useAuth } from '@/contexts/AuthContext';
import { useCreateReportMutation } from '@/hooks/use-menu-mutations';
import { useEditorStore } from '@/layout/state/editorStore';
import type { PanelLoadStatus } from '@/components/reports/panelLoadStatus';
import type { AgentChatResult } from '@/types/agent';
import { applyDashboard } from './applyDashboard';
import { PreviewDialog } from './PreviewDialog';
import { resultCardState } from './resultCardState';

interface ResultCardProps {
  result: AgentChatResult;
  /** D15, computed once in AiChat from the same useAuth().user.role read below. */
  canApply: boolean;
  /** A chat turn is in flight. */
  isPending: boolean;
}

/** i18n key paths — resolved with t() at the render site below. */
const APPLY_DISABLED_TOOLTIP: Record<'role' | 'pending' | 'applying' | 'preview' | 'previewing', string> = {
  role: 'ai_chat.result_card.apply_button.tooltip.role',
  pending: 'ai_chat.result_card.apply_button.tooltip.pending',
  applying: 'ai_chat.result_card.apply_button.tooltip.applying',
  preview: 'ai_chat.result_card.apply_button.tooltip.preview',
  previewing: 'ai_chat.result_card.apply_button.tooltip.previewing',
};

/**
 * The card under an assistant turn that carries a dashboard: preview it, then apply it.
 *
 * Preview is available to every role and is never automatic — a click opens it, so the
 * SQL it executes is bounded by deliberate user action (R-LOAD). Apply is admin/editor
 * only, and that check is cosmetic: the server enforces it with `requireAdminOrEditor`
 * on POST /api/reports and POST /api/sections. (DO-313)
 */
export function ResultCard({ result, canApply, isPending }: ResultCardProps) {
  const { t } = useLocale();
  const { user } = useAuth();
  const navigate = useNavigate();
  const createReportMutation = useCreateReportMutation();
  const [open, setOpen] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [isApplying, setIsApplying] = useState(false);

  // The SCHEMA that has been previewed to completion, not a boolean: a card can be
  // reused for a different result — `turnToBubble` mints `history-${index}` ids, so a
  // rehydration that shifts the list hands the same key a different turn — and an
  // "already previewed" flag would carry over and unlock Apply for a dashboard nobody
  // has executed. Comparing identity makes a stale preview worth nothing.
  const [previewedSchema, setPreviewedSchema] = useState<unknown>(null);
  const previewCompleted = previewedSchema === result.report_schema;

  // ...but comparing identity was NOT enough on its own, because the completion could
  // write the new schema on the old schema's evidence.
  //
  // A mounted DashboardRenderer re-emits its CURRENT status whenever the identity of
  // `onPanelStatusChange` changes (it is in that effect's deps). So when this card was
  // handed a different result while a preview was open, the renderer — still holding
  // the previous dashboard, its panelData still terminal — emitted that terminal status
  // again, and a completion handler closing over the NEW `result` recorded the new
  // schema as previewed. Worse with agent output than it sounds: artifacts number their
  // panels 1..N, so the new dashboard's panels find the old dashboard's data by id and
  // the count looks terminal rather than empty.
  //
  // The run is therefore INVALIDATED here, in the same render that sees the new schema,
  // before any effect can fire: the nonce remounts the renderer (its fresh state counts
  // every panel as pending) and any completion recorded for the old schema is dropped.
  // React's documented "adjust state when props change" pattern — it re-renders
  // immediately, so no committed frame ever shows the stale unlock.
  // (!64 review round 7, finding 1)
  const [runSchema, setRunSchema] = useState<unknown>(result.report_schema);
  if (runSchema !== result.report_schema) {
    setRunSchema(result.report_schema);
    setPreviewNonce((n) => n + 1);
    setPreviewedSchema(null);
  }

  // Verified rather than assumed, and stable across every render that is NOT a schema
  // change — which is the contract PreviewDialog's `handleStatus` documents and an
  // inline arrow quietly broke, re-firing the renderer's status effect on every render
  // of this card.
  // `_status` is named and unused deliberately: dropping it makes this take the STATUS
  // as its first argument, which TypeScript accepts without a murmur (a function of
  // fewer parameters is assignable) and which silently compares a status object against
  // a schema, so the gate never opens. Caught by the integration test below, in seconds.
  const handlePreviewComplete = useCallback((_status: PanelLoadStatus, schema: unknown) => {
    if (schema !== result.report_schema) return;
    setPreviewedSchema(schema);
  }, [result.report_schema]);

  // The role is read here for the REASON (a viewer needs different copy from an
  // unresolved session); `canApply` is AiChat's single D15 computation of the same
  // useAuth().user.role. Requiring both can only ever be the safer answer.
  const state = resultCardState(user?.role, isPending, isApplying, {
    open,
    completed: previewCompleted,
  });
  const applyEnabled = state.canApply && canApply;
  const disabledReason = applyEnabled ? null : state.applyDisabledReason ?? 'role';

  const panels = result.report_schema['panels'];
  const panelCount = Array.isArray(panels) ? panels.length : 0;

  // reset() runs in the OPEN HANDLER, not in a mount effect. Child effects run before
  // parent effects, so an effect-based reset would fire AFTER the renderer's own
  // setDashboard and blank it. It drops any dashboard/isEditingLayout left over from a
  // report the user was editing, and stops the 2nd preview painting the 1st preview's
  // dashboard — refining before Apply reopens this modal repeatedly. The nonce gives
  // each opening a fresh renderer instance. (DO-313)
  const openPreview = () => {
    useEditorStore.getState().reset();
    setPreviewNonce((n) => n + 1);
    setOpen(true);
  };

  const handleApply = () => {
    if (!applyEnabled) return;
    setIsApplying(true);
    // Every failure path re-enables the button through onSettled; the success path
    // navigates away and this card unmounts with the page.
    //
    // The .catch is a BACKSTOP, not a failure path — applyDashboard names every failure
    // it can. It is here because the disabled state is owned HERE: whether the button
    // comes back must not depend on a helper staying correct. Without it an unexpected
    // throw is an unhandled rejection, onSettled never runs, and Apply sits disabled
    // behind "Creating the dashboard..." until the page is reloaded, with nothing on
    // screen saying why. Silent on purpose — a message here could only guess, and
    // applyDashboard has already spoken for everything it knows.
    // (!64 review round 5, finding 1)
    void applyDashboard({
      result,
      createReportMutation,
      navigate,
      onSettled: () => setIsApplying(false),
    }).catch(() => setIsApplying(false));
  };

  // One element, rendered in two places: here and in the preview dialog's footer, so
  // the decision can be taken where the evidence is. Never a second implementation.
  const applyButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button fires no pointer events; the span is what the tooltip
            can hang off, so the reason is reachable exactly when it is needed. */}
        <span className="inline-flex" tabIndex={applyEnabled ? -1 : 0}>
          <Button
            onClick={handleApply}
            disabled={!applyEnabled}
            className="disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ai_chat.result_card.apply_button.cta')}
          </Button>
        </span>
      </TooltipTrigger>
      {disabledReason && <TooltipContent>{t(APPLY_DISABLED_TOOLTIP[disabledReason])}</TooltipContent>}
    </Tooltip>
  );

  return (
    <div
      className={cn(
        'mt-2 rounded-md border border-border bg-card px-4 py-3 text-left',
        isPending && 'opacity-60',
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('ai_chat.result_card.header.label')}
      </p>
      <p className="mt-1 text-sm font-medium text-foreground">{result.title}</p>
      {/* Noun first, count after the colon: the runtime has no plural rules, and
          "1 panel" / "N panels" chosen in code cannot be translated (Russian has
          three forms). See previewStatusText.ts for the full reasoning. */}
      <p className="text-xs text-muted-foreground">
        {t('ai_chat.result_card.panel_count.label', { count: panelCount })}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="secondary" onClick={openPreview}>
          {t('ai_chat.result_card.preview_button.cta')}
        </Button>
        {applyButton}
      </div>

      <PreviewDialog
        result={result}
        open={open}
        onOpenChange={setOpen}
        nonce={previewNonce}
        applyAction={applyButton}
        // R27's gate, made real: Apply unlocks only once THIS schema has been executed
        // against the user's data and the result was on screen. The dialog fires this
        // on a terminal status and on nothing else, so closing the preview mid-run,
        // an unreadable schema and unreadable globals all leave Apply where it was.
        // It reports WHICH schema the run belongs to; the handler above checks it.
        // (!64 review round 6, finding 1; round 7, finding 1)
        onPreviewComplete={handlePreviewComplete}
      />
    </div>
  );
}

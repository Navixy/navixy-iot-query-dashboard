import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useCreateReportMutation } from '@/hooks/use-menu-mutations';
import { useEditorStore } from '@/layout/state/editorStore';
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

const APPLY_DISABLED_TOOLTIP: Record<'role' | 'pending' | 'applying' | 'preview' | 'previewing', string> = {
  role: 'Ask an editor to create this dashboard',
  pending: 'Wait for the current reply to finish',
  applying: 'Creating the dashboard...',
  preview: 'Preview this dashboard first',
  previewing: 'Wait for the preview to finish',
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
  const { user } = useAuth();
  const navigate = useNavigate();
  const createReportMutation = useCreateReportMutation();
  const [open, setOpen] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [isApplying, setIsApplying] = useState(false);

  // The SCHEMA that has been previewed to completion, not a boolean: a card can be
  // reused for a different result (the transcript keys bubbles positionally), and an
  // "already previewed" flag would carry over and unlock Apply for a dashboard nobody
  // has executed. Comparing identity makes a stale preview worth nothing.
  const [previewedSchema, setPreviewedSchema] = useState<unknown>(null);
  const previewCompleted = previewedSchema === result.report_schema;

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
            Apply
          </Button>
        </span>
      </TooltipTrigger>
      {disabledReason && <TooltipContent>{APPLY_DISABLED_TOOLTIP[disabledReason]}</TooltipContent>}
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
        Result ready
      </p>
      <p className="mt-1 text-sm font-medium text-foreground">{result.title}</p>
      <p className="text-xs text-muted-foreground">
        {panelCount === 1 ? '1 panel' : `${panelCount} panels`}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="secondary" onClick={openPreview}>
          Preview
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
        // (!64 review round 6, finding 1)
        onPreviewComplete={() => setPreviewedSchema(result.report_schema)}
      />
    </div>
  );
}

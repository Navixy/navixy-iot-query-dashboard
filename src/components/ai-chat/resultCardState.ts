/**
 * Which of a result card's two actions are available, and why not.
 *
 * Extracted as a pure function so it is testable: this repo's chat tests run in
 * Vitest's `node` environment by default, and the rule is the part worth pinning —
 * the rendering around it is not. Same extraction pattern as `markdown.ts`.
 *
 * The gate here is COSMETIC. The server enforces the real one: POST /api/reports
 * and POST /api/sections both carry `requireAdminOrEditor` and answer a viewer with
 * 403. This exists so a viewer sees an explanation instead of a raw error. (DO-313)
 */
export type Role = 'admin' | 'editor' | 'viewer';

export interface ResultCardState {
  /** Preview is read-only and available to every role, always. */
  canPreview: boolean;
  canApply: boolean;
  /** Null exactly when `canApply` is true. */
  applyDisabledReason: 'role' | 'pending' | 'applying' | 'preview' | 'previewing' | null;
}

/**
 * Has this exact result been executed against the user's data yet?
 *
 * `completed` means a mounted renderer reported a terminal status — nothing pending —
 * for THIS result's schema. It is deliberately not "the dialog was opened": a preview
 * closed while its panels were still running has proved nothing, and neither has one
 * whose schema could not be read as a dashboard (no renderer mounts, so no status ever
 * arrives). `open` only picks the copy apart: "you have not previewed" and "the preview
 * has not finished" need different sentences.
 */
export interface PreviewProgress {
  open: boolean;
  completed: boolean;
}

/**
 * @param role      the signed-in user's role; `undefined` while auth is unresolved
 * @param isPending a chat turn is in flight — Apply navigates away, and navigating
 *                  mid-turn is exactly what R26 exists for
 * @param isApplying this card's own Apply is already running
 * @param preview   whether this result has been previewed to a terminal status
 *
 * **Why the preview gate is in this function and not in a comment.** R27: the preview
 * is the feature's ONLY correctness control — `validateDashboard` answers "can this
 * dashboard hurt us or fail to render", never "is this dashboard right", and the first
 * real agent dashboard passed every static check with a column that does not exist. A
 * control the user can walk past is advisory, not a control. Failed panels still allow
 * Apply (a user may legitimately save 9 of 10 and fix the last in the layout editor) —
 * the requirement is that the execution HAPPENED and its result was on screen, not that
 * it was clean. (!64 review round 6, finding 1)
 */
export function resultCardState(
  role: Role | undefined,
  isPending: boolean,
  isApplying: boolean,
  preview: PreviewProgress,
): ResultCardState {
  // Preview is never gated: it is read-only, it is the only thing that catches a
  // hallucinated column, and making it skippable or unreachable is forbidden (R27).
  const canPreview = true;

  // Reason precedence follows the spec's own order — role, then pending, then
  // applying — so a viewer is always told the durable reason rather than a
  // transient one that would still leave Apply disabled afterwards.
  if (role !== 'admin' && role !== 'editor') {
    return { canPreview, canApply: false, applyDisabledReason: 'role' };
  }
  if (isPending) {
    return { canPreview, canApply: false, applyDisabledReason: 'pending' };
  }
  if (isApplying) {
    return { canPreview, canApply: false, applyDisabledReason: 'applying' };
  }
  if (!preview.completed) {
    return {
      canPreview,
      canApply: false,
      applyDisabledReason: preview.open ? 'previewing' : 'preview',
    };
  }
  return { canPreview, canApply: true, applyDisabledReason: null };
}

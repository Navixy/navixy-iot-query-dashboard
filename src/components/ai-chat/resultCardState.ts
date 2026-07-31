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
  applyDisabledReason: 'role' | 'pending' | 'applying' | null;
}

/**
 * @param role      the signed-in user's role; `undefined` while auth is unresolved
 * @param isPending a chat turn is in flight — Apply navigates away, and navigating
 *                  mid-turn is exactly what R26 exists for
 * @param isApplying this card's own Apply is already running
 */
export function resultCardState(
  role: Role | undefined,
  isPending: boolean,
  isApplying: boolean,
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
  return { canPreview, canApply: true, applyDisabledReason: null };
}

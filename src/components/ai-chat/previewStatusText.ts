/**
 * The preview banner's copy and severity, decided from the renderer's panel counts.
 *
 * Pure and separate from the dialog so it is testable in the `node` environment, and
 * so the one string a user must not miss — the failure count — is pinned by tests
 * rather than by a screenshot. (DO-313)
 *
 * LOCALIZED, and that is why the wording changed. This used to read naturally in
 * English ("3 panels failed — check them before applying") by picking words in code:
 * `n === 1 ? 'panel' : 'panels'` plus `'it' : 'them'`, assembled from fragments. Both
 * are English-only constructs:
 *   - the choice happened in CODE, so `panel`/`panels` never reached a translator;
 *   - `n === 1 ? A : B` is an English rule. Russian has THREE forms (1 панель,
 *     2 панели, 5 панелей) selected by the last digit, so no pair of words is correct;
 *   - a sentence glued from fragments cannot be reordered, and a pronoun has to agree
 *     with a noun the translator never sees.
 * The app's runtime has no plural rules by design (no ICU — see
 * docs/UI_TEXT_STYLE_GUIDE.md), so the copy uses the house "crutch" instead: the noun
 * comes first and the number follows a colon, which never has to agree with it.
 * Each sentence below is one whole translatable unit; only complete sentences are
 * joined, never fragments.
 */
import type { PanelLoadStatus } from '@/components/reports/panelLoadStatus';
import type { TFunction } from '@/i18n/makeT';

export type PanelStatusSeverity = 'muted' | 'destructive';

export interface PanelStatusDescription {
  text: string;
  severity: PanelStatusSeverity;
  /** True while panels are still executing — the banner shows a spinner. */
  busy: boolean;
}

/**
 * @param status the renderer's latest counts, or `null` before it has reported any.
 * @param t the active translator. Passed in rather than read from a hook: this module
 *   is pure so it can be unit-tested outside React, and its only caller is a component.
 *
 * The null case is not the same as `{total: 0}` and must not be folded into it: the
 * renderer emits its first status from a passive effect, so an all-zero initial state
 * would have the banner announce "This dashboard has no data panels" about a
 * dashboard nobody has counted yet — briefly on every preview, and permanently on the
 * one path where no renderer ever mounts.
 */
export function describePanelStatus(
  status: PanelLoadStatus | null,
  t: TFunction,
): PanelStatusDescription {
  if (!status) {
    return {
      text: t('ai_chat.preview_dialog.status.paragraph.loading'),
      severity: 'muted',
      busy: true,
    };
  }

  const { total, loaded, failed, pending, unverifiable } = status;

  if (total === 0 && unverifiable === 0) {
    return {
      text: t('ai_chat.preview_dialog.status.no_panels.paragraph.empty'),
      severity: 'muted',
      busy: false,
    };
  }

  // Loading wins over a partial failure count: mid-load the count is not final, and
  // every panel settles (each query writes either data or an error), so a failure
  // cannot hide here permanently — it surfaces the moment the last panel lands.
  // The unverifiable clause waits with it: nothing about it changes, and a countdown
  // is hard enough to read without a second number beside it.
  if (pending > 0) {
    return {
      text: t('ai_chat.preview_dialog.status.loading_count.paragraph.loading', { count: pending }),
      severity: 'muted',
      busy: true,
    };
  }

  // "Panels not checked" is DESTRUCTIVE for the same reason a failure is: the
  // preview is the only thing that can tell the user whether this dashboard works, and
  // for those panels it did not run. Saying it quietly would be the old behaviour of
  // dropping them, one shade lighter. (!64 review round 6, finding 3)
  const notChecked = unverifiable > 0
    ? t('ai_chat.preview_dialog.status.not_checked.paragraph.warning', { count: unverifiable })
    : '';

  if (total === 0) {
    return { text: notChecked, severity: 'destructive', busy: false };
  }

  const severity: PanelStatusSeverity =
    failed > 0 || unverifiable > 0 ? 'destructive' : 'muted';

  const base = failed > 0
    ? t('ai_chat.preview_dialog.status.partial.paragraph.failure', { loaded, total, failed })
    : t('ai_chat.preview_dialog.status.all_loaded.paragraph.success', { total });

  // Two COMPLETE sentences joined by a space — not a sentence built from fragments.
  // Each is translated as a whole, so this join stays valid in any language.
  return { text: notChecked ? `${base} ${notChecked}` : base, severity, busy: false };
}

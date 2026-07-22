/**
 * Discovery chips for the empty chat. Deliberately hardcoded, NOT derived from
 * AGENT_CORPUS: that lives in backend/src/services/agent/corpus.generated.ts, a separate
 * TS program (backend/tsconfig.json rootDir "./src") the frontend cannot import — and these
 * must keep making sense once Bedrock replaces the mock.
 *
 * Each string hits a DISTINCT corpus keyword row, so the mock returns four different
 * dashboards during a demo. If the corpus keyword table changes, re-check these four
 * (they are not enforced by any test).
 *
 * NOT localized, deliberately. A chip is not just a label: picking one fills the
 * composer with that exact text, which is then sent to the agent as the prompt. The
 * ASCII-only test beside this file mechanically guards the no-Cyrillic rule for that
 * reason, so these must stay English even when the surrounding UI is translated.
 * Revisit only together with the agent's language handling.
 * See docs/i18n-terminology-flags.md.
 */
export const CHAT_SUGGESTIONS = [
  'Track vehicle mileage over the last month',
  'Show leasing costs by contract',
  'Driver performance and safety scores',
  'Fleet anomalies and alerts',
] as const;

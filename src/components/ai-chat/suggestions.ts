/**
 * Discovery chips for the empty chat. Deliberately hardcoded, NOT derived from
 * AGENT_CORPUS: that lives in backend/src/services/agent/corpus.generated.ts, a separate
 * TS program (backend/tsconfig.json rootDir "./src") the frontend cannot import — and these
 * must keep making sense once Bedrock replaces the mock.
 *
 * Each string hits a DISTINCT corpus keyword row, so the mock returns four different
 * dashboards during a demo. If the corpus keyword table changes, re-check these four
 * (they are not enforced by any test).
 */
export const CHAT_SUGGESTIONS = [
  'Track vehicle mileage over the last month',
  'Show leasing costs by contract',
  'Driver performance and safety scores',
  'Fleet anomalies and alerts',
] as const;

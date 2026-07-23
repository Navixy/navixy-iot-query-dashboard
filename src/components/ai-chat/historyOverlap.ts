import type { AgentTurn, ChatBubble } from '@/types/agent';

/**
 * Deduplicates the SEAM between a late-arriving server history and the turns
 * this mount already rendered live (review !62 round 2, Important 5).
 *
 * The composer is deliberately usable while the initial GET /session is in
 * flight, so the user can send before it lands. When that response finally
 * arrives it may already CONTAIN the live turns: the backend persists the user
 * turn at POST receipt, and a slow GET serializes server-side after the POST —
 * so its tail can hold the in-flight user turn, or the whole finished exchange.
 * Rendering `history ++ live` untrimmed would show those turns twice; refusing
 * the response outright (the pre-fix behavior) hid the user's entire previous
 * transcript until the next remount.
 *
 * The overlap is structural, not fuzzy: live turns are appended to the server
 * transcript in send order, so any overlap is exactly a SUFFIX of `history`
 * equal to a PREFIX of `live`. The largest such k wins, compared by
 * (role, text) — matching content is precisely what a duplicate looks like.
 * Transport-error bubbles never match (the server holds no such turn), while a
 * persisted in-band type:'error' turn matches its live bubble by the same rule
 * as any other turn.
 *
 * Accepted cost: if the PREVIOUS conversation genuinely ended with the exact
 * text the user just re-sent, that old turn is trimmed too and stays hidden
 * for this mount only — the next mount reconciles from the server. Hiding a
 * look-alike beats rendering a certain duplicate.
 */
export function trimHistoryOverlap(
  history: AgentTurn[],
  live: ChatBubble[],
): AgentTurn[] {
  const max = Math.min(history.length, live.length);
  for (let k = max; k > 0; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      const turn = history[history.length - k + i];
      const bubble = live[i];
      if (turn.role !== bubble.role || turn.content !== bubble.text) {
        matches = false;
        break;
      }
    }
    if (matches) return history.slice(0, history.length - k);
  }
  return history;
}

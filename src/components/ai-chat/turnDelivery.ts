import type { AgentTurn, ChatBubble } from '@/types/agent';

export type TurnDelivery = 'completed' | 'received' | 'lost';

/** Shown when reconciliation could not confirm a lost turn either way. */
export const UNCERTAIN_DELIVERY_NOTICE =
  "We couldn't reach the server to confirm your last message was delivered. Reload the page to check before sending it again.";

/**
 * Builds the transcript for the UNCERTAIN reconcile outcome (review !62 round 5,
 * Critical 1). The optimistic user bubble is mount-local, so on a REMOUNT it is
 * gone and the message would be visible nowhere; re-materialize it from the
 * failed mutation (which outlives the mount). On the ORIGINAL mount the bubble
 * is already the last user turn — do not add a second copy. Either way append
 * the uncertain notice. The message is shown as a transcript bubble, never
 * restored to the composer, so it is preserved without becoming a one-click
 * resend of a turn the server may have taken.
 */
export function appendUncertainNotice(
  prev: ChatBubble[],
  message: string,
  makeId: () => string,
): ChatBubble[] {
  const lastUser = [...prev].reverse().find((b) => b.role === 'user');
  const restored: ChatBubble[] =
    lastUser?.text === message ? [] : [{ id: makeId(), role: 'user', text: message }];
  return [
    ...prev,
    ...restored,
    { id: makeId(), role: 'assistant', text: UNCERTAIN_DELIVERY_NOTICE, isError: true },
  ];
}

/** Number of USER turns in `history` whose content is exactly `content`. The
 *  send-time value is the reconciliation baseline below; the reconcile-time
 *  value is compared against it. */
export function countMatchingUserTurns(history: AgentTurn[], content: string): number {
  let n = 0;
  for (const turn of history) {
    if (turn.role === 'user' && turn.content === content) n += 1;
  }
  return n;
}

/**
 * Classifies what happened to a chat turn whose HTTP RESPONSE was lost
 * (review !62 rounds 3–4). POST /chat is not idempotent: the server persists
 * the user turn at receipt and the assistant turn after the agent finishes,
 * and the agent's memory is stateful (D19). A transport error therefore does
 * NOT mean the turn failed — the server may have processed it completely with
 * only the response dying. An authoritative GET /session tells the states
 * apart, but ONLY relative to a SEND-TIME BASELINE.
 *
 * `priorOccurrences` is how many user turns with this exact content the client
 * already knew about at send time (from the session-cache snapshot). Without
 * it, a repeated prompt is silent data loss (review !62 round 4, Important 2):
 * if the user successfully sent "refresh this dashboard" earlier and sends it
 * again, and THAT second POST is genuinely lost, the OLD identical turn matches
 * and the attempt is wrongly called 'completed' — the failed mutation is
 * dropped, the draft is not restored, and the new command vanishes. Requiring a
 * match STRICTLY BEYOND the baseline means only a turn the server added THIS
 * time counts as delivery.
 *
 * - 'completed' — a new occurrence exists AND an assistant turn follows the
 *   newest matching user turn. The turn SUCCEEDED; render server truth. Never
 *   restore the draft here: it would invite re-sending a message the agent
 *   already consumed (R20).
 * - 'received' — a new occurrence exists with no assistant after it yet: the
 *   server got it and the agent may still be working (it keeps processing
 *   after a client disconnect). Do not restore the draft.
 * - 'lost' — no occurrence beyond the baseline: the server transcript does not
 *   contain this send. Retrying is safe; the caller restores the draft — but
 *   ONLY on a SUCCESSFUL, settled GET, never on a failed or in-flight one
 *   (that ambiguity is the caller's 'uncertain' path, not 'lost').
 *
 * An assistant turn of any type counts, including type:'error': an in-band
 * failure the server persisted IS the turn's outcome. Completed-vs-received
 * looks after the NEWEST matching user turn — our just-sent turn is the newest
 * of its content, so an assistant after it is its answer even if a concurrent
 * tab appended around it.
 *
 * RESIDUAL EDGE (no client turn id exists — that is the real fix, deferred):
 * the newest-MAX_TURNS window can evict an OLD identical turn exactly as ours
 * is appended, leaving the count equal to the baseline; the turn is then called
 * 'lost' though it was delivered. That degrades to a draft restore (safe-ish:
 * text preserved, a double-feed only on an explicit manual resend), never to
 * silent loss. Requires the transcript within ~2 of the 100 cap AND a prior
 * identical turn old enough to slide — narrow, and strictly better than the
 * newest-match rule it replaces.
 */
export function classifyTurnDelivery(
  history: AgentTurn[],
  sentMessage: string,
  priorOccurrences = 0,
): TurnDelivery {
  // Indices of every matching user turn, oldest-first.
  const matches: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    if (turn.role === 'user' && turn.content === sentMessage) matches.push(i);
  }
  // No occurrence beyond what we already knew at send time → not delivered.
  if (matches.length <= priorOccurrences) return 'lost';

  const newestMatch = matches[matches.length - 1];
  for (let j = newestMatch + 1; j < history.length; j++) {
    if (history[j].role === 'assistant') return 'completed';
  }
  return 'received';
}

/** What the failed-turn reconciler should DO once its bounded poll has run. */
export type ReconcileOutcome =
  /** The server has the turn (completed/received): render server truth, no draft. */
  | 'delivered'
  /** The turn provably never reached the server: safe to restore the draft. */
  | 'confirmed-lost'
  /** We could not confirm either way: preserve the message, do NOT restore the
   *  draft (an auto-retry might double-feed a turn the server did take). */
  | 'uncertain';

/**
 * Turns the poll's results into the reconcile branch to take.
 *
 * A POSITIVE delivery (completed/received) is trustworthy whenever any GET saw
 * it — it cannot un-happen. A 'lost' verdict is the subtle one: the route does
 * loadHistory BEFORE it appends the user turn, so the FIRST GET can overtake an
 * in-flight POST and read the turn as absent. The bounded poll re-checks to
 * close that window — but only if the later probes actually SUCCEED. If an early
 * GET said 'lost' and every later probe then FAILED, the absence was never
 * re-confirmed after the overtake window and the true state is UNCERTAIN, not
 * lost — restoring the draft there would invite re-sending a turn the server may
 * have taken (review !62 round 5, Important 3). So 'lost' is only trusted when
 * the MOST RECENT probe succeeded and still showed the turn missing.
 */
export function reconcileOutcome(
  anyGetSucceeded: boolean,
  delivery: TurnDelivery,
  lastGetSucceeded: boolean,
): ReconcileOutcome {
  if (anyGetSucceeded && delivery !== 'lost') return 'delivered';
  if (anyGetSucceeded && delivery === 'lost' && lastGetSucceeded) return 'confirmed-lost';
  return 'uncertain';
}

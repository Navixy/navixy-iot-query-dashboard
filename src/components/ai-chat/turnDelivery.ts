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
 * (review !62 rounds 3–6). POST /chat is not idempotent: the server persists
 * the user turn at receipt and the assistant turn after the agent finishes,
 * and the agent's memory is stateful (D19). A transport error therefore does
 * NOT mean the turn failed — the server may have processed it completely with
 * only the response dying. An authoritative GET /session tells the states apart.
 *
 * PRIMARY: MATCH BY client_turn_id (review !62 round 6, findings 4/5 — the fix
 * the reviewer asked for across rounds 3–6). The browser mints a UUID per send;
 * the server persists it on the user turn and returns it here. Matching by that
 * id is DETERMINISTIC: it identifies THIS exact send, so concurrent identical
 * turns from another tab, a repeated prompt, and the sliding 100-turn cap are
 * all unambiguous — none of which content counting can resolve. The id is
 * trusted only when the server actually round-trips ids: if ANY user turn in the
 * transcript carries one, the server persists them, so the ABSENCE of ours is
 * proof the send never landed. If NO user turn carries one (a tenant on an older
 * 002 without the column, or a pre-feature transcript), fall through.
 *
 * FALLBACK: content + a SEND-TIME occurrence baseline. `priorOccurrences` is how
 * many user turns with this exact content the client already knew about at send
 * time. Without it a repeated prompt is silent data loss (round 4, Important 2):
 * a genuinely-lost re-send of "refresh" would match the OLD identical turn and be
 * called 'completed'. Requiring a match STRICTLY BEYOND the baseline means only a
 * turn the server added THIS time counts. This path keeps its documented residual
 * (the cap can evict an old identical turn as ours lands, degrading to a safe
 * draft restore) — but it now only runs where no id is available; with the id the
 * residual is closed.
 *
 * - 'completed' — the turn is present AND an assistant turn follows it. Succeeded;
 *   render server truth. Never restore the draft (would re-feed the agent, R20).
 * - 'received' — the turn is present with no assistant after it yet: the server
 *   got it and the agent may still be working. Do not restore the draft; the
 *   caller keeps the composer locked (Important 4).
 * - 'lost' — the turn is absent: retrying is safe and the caller restores the
 *   draft, but ONLY on a SUCCESSFUL settled GET (else it is 'uncertain').
 *
 * An assistant turn of any type counts, including type:'error': an in-band
 * failure the server persisted IS the turn's outcome.
 */
export function classifyTurnDelivery(
  history: AgentTurn[],
  sentMessage: string,
  clientTurnId: string | null,
  supportsTurnIds: boolean,
  priorOccurrences = 0,
): TurnDelivery {
  // PRIMARY — exact-pair id match, trusted from the EXPLICIT capability flag
  // (finding 5a), not inferred from a visible row.
  if (clientTurnId && supportsTurnIds) {
    // Completion = an ASSISTANT turn stamped with OUR id (finding 3) — never "any
    // later assistant", which mis-attributed a concurrent turn's reply.
    if (history.some((t) => t.role === 'assistant' && t.client_turn_id === clientTurnId)) {
      return 'completed';
    }
    // Our user turn present, no matching reply yet → received; absent from THIS
    // transcript → lost, which the caller reconfirms against the durable receipt
    // before trusting (finding 5b — the row can be evicted by 100 newer turns).
    if (history.some((t) => t.role === 'user' && t.client_turn_id === clientTurnId)) {
      return 'received';
    }
    return 'lost';
  }

  // FALLBACK — content + send-time occurrence baseline (no id support).
  const matches: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    if (turn.role === 'user' && turn.content === sentMessage) matches.push(i);
  }
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

/**
 * After reconciliation, must the composer STAY LOCKED (review !62 round 6,
 * Important 4)? A turn that reached the server but has no assistant reply yet
 * ('received'), or one we could not confirm ('uncertain'), may still be running
 * on the STATEFUL agent — a second POST now would race that invocation and
 * interleave the transcript out of order. Only 'completed' (the reply is already
 * present) and 'confirmed-lost' (never arrived, so the draft is restored for a
 * clean retry) are safe to unlock. Reloading the page re-observes the session and
 * is the explicit way out of the lock.
 */
export function locksComposerAwaitingReply(
  outcome: ReconcileOutcome,
  delivery: TurnDelivery,
): boolean {
  if (outcome === 'uncertain') return true;
  return outcome === 'delivered' && delivery === 'received';
}

/**
 * Fold a DURABLE-RECEIPT lookup into a poll's delivery verdict (review !62 round
 * 7, finding 5b). Only a 'lost' verdict is reconsidered — a positive delivery
 * already saw the turn, and a receipt cannot un-happen it. On the id path a 'lost'
 * only means "not in THIS capped transcript"; the receipt lives outside that
 * window, so it is authoritative. `supported: false` (older schema / demo) leaves
 * the transcript verdict untouched, and an unknown-but-supported receipt confirms
 * the turn genuinely never reached the server.
 */
export function applyReceiptToDelivery(
  delivery: TurnDelivery,
  receipt: { status: 'received' | 'answered' | 'unknown'; supported: boolean } | null,
): TurnDelivery {
  if (delivery !== 'lost' || !receipt?.supported) return delivery;
  if (receipt.status === 'answered') return 'completed';
  if (receipt.status === 'received') return 'received';
  return 'lost';
}

/**
 * True when the persisted transcript's NEWEST turn is a USER turn — a turn is
 * still in flight, because the route appends the assistant reply only AFTER the
 * agent call (review !62 round 7, finding 4). Deriving the composer lock from this
 * SERVER state (re-read from GET /session on every mount) is what makes it survive
 * a route remount, which the round-6 mount-local flag did not.
 */
export function sessionAwaitsReply(messages: AgentTurn[]): boolean {
  return messages.length > 0 && messages[messages.length - 1].role === 'user';
}

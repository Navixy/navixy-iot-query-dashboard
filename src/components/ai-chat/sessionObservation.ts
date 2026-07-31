import { getAuthSessionId } from '@/lib/authSession';
import type { AgentSessionResponse } from '@/types/agent';
import { answeredTurnIds, resolveAwaitingReply, type AwaitingReplyVerdict } from './turnDelivery';

/**
 * ONE READING of the session state, stamped with WHEN IT WAS ASKED FOR and WHO
 * ASKED (review !62 round 14, Important 1; corrected round 15, Important 1 & 2).
 *
 * Round 13 released the composer lock on the VERDICT STRING alone, and a bare
 * verdict cannot say WHICH observation produced it. Both directions broke:
 *
 *  - a lock taken while the cache already read 'idle' could never be released,
 *    because the next successful GET returned the same string, the effect
 *    dependency did not change, and the effect never re-ran. Locked for the whole
 *    mount — the very deadlock round 12's TTL was introduced to end;
 *  - and the reverse released a lock it should have held: reconciliation reads a
 *    GET (idle), a LATER receipt lookup upgrades the turn to 'received', the lock
 *    is taken — and then that older GET is published into the query cache, where
 *    it looks brand new and cancels the lock that its own successor had just
 *    justified. A second turn then goes out at the stateful agent.
 *
 * Round 14 answered both with a generation minted WHEN THE RESPONSE ARRIVED. That
 * orders readings by COMPLETION, and completion order is not observation order:
 *
 *    GET dispatched ─────────(slow network)─────────► response recorded
 *                    receipt proves 'received' → LOCK
 *
 * The lock's baseline is everything recorded so far, so the delayed response —
 * whose server snapshot was taken BEFORE the turn even reached the agent — landed
 * above it and passed for news. It says nothing about the turn the lock is about.
 *
 * So a reading is ordered by a TICKET DRAWN BEFORE ITS REQUEST GOES OUT, and a
 * lock is measured against the tickets ISSUED at that moment rather than the ones
 * already back. Only a read whose request LEFT after the lock can release it —
 * whenever it happens to return, and however many faster reads overtake it.
 */
export interface SessionReadTicket {
  /** Monotonic, drawn before dispatch. */
  id: number;
  /** The auth epoch current at dispatch; null when nobody is signed in. */
  epoch: string | null;
}

export interface SessionObservation {
  /** The ticket of the read that produced this. 0 is "nothing has ever been
   *  read", which can release nothing. */
  ticket: number;
  /** The authenticated presence that asked. A reading belongs to the identity
   *  that requested it, never to whoever happens to be signed in when it lands. */
  epoch: string | null;
  verdict: AwaitingReplyVerdict;
  /** client_turn_ids this reading shows an assistant reply for. */
  answeredTurnIds: readonly string[];
}

/**
 * WHY A LEDGER OF ITS OWN, rather than reading React Query's cache.
 *
 * The session cache answers "what should the page render", which is a different
 * question from "when did the server last tell us anything, and what did it say".
 * All three of its write paths lie about the second one:
 *
 *  - STRUCTURAL SHARING. A refetch whose payload is deep-equal keeps the ORIGINAL
 *    data object (use-agent-chat.ts relies on this), so a genuine new read that
 *    changed nothing is invisible from `data` identity — and "the server said idle
 *    again" is exactly the observation that must release a stuck lock.
 *  - setQueryData REPUBLISHES. The reconciler writes the response it read seconds
 *    earlier; dataUpdatedAt jumps to now and an old reading passes for a fresh one.
 *  - settleChatTurnIntoSessionCache SYNTHESIZES. It spreads the previous response
 *    and appends the two new turns, so the result carries that response's
 *    awaiting_reply verbatim. It is not a reading of the server at all.
 *
 * Only the code that performs a GET /session knows it performed one, so that is
 * what draws a ticket here: the query fetcher (fetchAgentSession) and the
 * reconciler's own poll. Everything else is rendering.
 *
 * MODULE-LEVEL because the readings are made outside React's render cycle, but
 * every entry carries its EPOCH (round 15, Important 2). Round 14 argued scoping
 * was unnecessary — locks unmount at sign-out, so nothing observed earlier could
 * outlive one — and that argument was the round-15 defect in miniature: it, too,
 * assumed a read is over when the lock is taken. queryClient.clear() drops the
 * QUERY but not the underlying request, which has no AbortSignal to cancel, so a
 * previous tenant's GET really can settle into the next tenant's page. It is
 * dropped here rather than being allowed to speak for an identity that never
 * asked it anything.
 */
const NOTHING_OBSERVED: SessionObservation = {
  ticket: 0,
  epoch: null,
  verdict: 'unknown',
  answeredTurnIds: [],
};

/** High-water mark of tickets ISSUED — not of readings returned. */
let issued = 0;
let latest: SessionObservation = NOTHING_OBSERVED;
const listeners = new Set<() => void>();

/** Draw a ticket for a GET /session that is ABOUT TO BE DISPATCHED, and bind it
 *  to the identity dispatching it. Call this immediately before the request, so
 *  that anything decided afterwards outranks it. */
export function beginSessionRead(): SessionReadTicket {
  issued += 1;
  return { id: issued, epoch: getAuthSessionId() };
}

/** The baseline a lock taken NOW must be measured against: every read already ON
 *  ITS WAY is, by definition, not evidence about a decision being made after it —
 *  its snapshot of the server predates this moment no matter when it returns. */
export function currentReadHighWaterMark(): number {
  return issued;
}

/** Record a SUCCESSFUL GET /session against the ticket it was dispatched with.
 *  A failed read records nothing — the absence of an answer is not an answer.
 *  Returns the ledger's state, which is unchanged when this reading is dropped. */
export function recordSessionObservation(
  ticket: SessionReadTicket,
  response: AgentSessionResponse | null | undefined,
): SessionObservation {
  // The identity that asked is gone: a sign-out, or another tenant signed in
  // while this was in flight. Nobody here is entitled to this answer.
  if (ticket.epoch !== getAuthSessionId()) return latest;
  // A newer read already answered. Keeping the newest reading rather than the
  // last-arrived one is the same rule as the release: order by ticket, not by
  // completion.
  if (ticket.id <= latest.ticket) return latest;

  latest = {
    ticket: ticket.id,
    epoch: ticket.epoch,
    verdict: resolveAwaitingReply(response),
    answeredTurnIds: answeredTurnIds(response?.messages),
  };
  // Copy: a listener that unsubscribes while being notified must not perturb the
  // iteration of the others.
  for (const listener of [...listeners]) listener();
  return latest;
}

/** useSyncExternalStore's getSnapshot: a stable reference between records. */
export function getSessionObservation(): SessionObservation {
  return latest;
}

export function subscribeToSessionObservations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

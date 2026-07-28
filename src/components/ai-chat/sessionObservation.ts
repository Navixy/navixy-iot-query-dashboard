import type { AgentSessionResponse } from '@/types/agent';
import { answeredTurnIds, resolveAwaitingReply, type AwaitingReplyVerdict } from './turnDelivery';

/**
 * ONE READING of the session state, stamped WITH WHEN IT WAS READ (review !62
 * round 14, Important 1).
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
 * So an observation carries a GENERATION, minted at the moment the response comes
 * back from the network. A lock records the generation it was taken at, and only
 * an observation NEWER than that baseline may release it.
 */
export interface SessionObservation {
  /** Monotonic, minted at READ time and never re-minted by a later re-publish.
   *  0 is "nothing has ever been read", which can release nothing. */
  generation: number;
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
 * what records here: the query fetcher (fetchAgentSession) and the reconciler's
 * own poll. Everything else is rendering.
 *
 * MODULE-LEVEL, and deliberately NOT epoch-scoped like the query keys are: locks
 * live in a mounted component, a sign-out unmounts it, and every lock's baseline
 * is taken when the lock is — so nothing observed before it, under any identity,
 * can release it. The ids are UUIDs, so the identity half cannot collide either.
 */
const NOTHING_OBSERVED: SessionObservation = {
  generation: 0,
  verdict: 'unknown',
  answeredTurnIds: [],
};

let latest: SessionObservation = NOTHING_OBSERVED;
const listeners = new Set<() => void>();

/** Record a SUCCESSFUL GET /session. Call this where the response arrives, not
 *  where it is later rendered or re-published. A failed read records nothing —
 *  the absence of an answer is not an answer. */
export function recordSessionObservation(
  response: AgentSessionResponse | null | undefined,
): SessionObservation {
  latest = {
    generation: latest.generation + 1,
    verdict: resolveAwaitingReply(response),
    answeredTurnIds: answeredTurnIds(response?.messages),
  };
  // Copy: a listener that unsubscribes while being notified must not perturb the
  // iteration of the others.
  for (const listener of [...listeners]) listener();
  return latest;
}

/** The high-water mark — the baseline a lock taken NOW must be measured against.
 *  Everything already observed is, by definition, not evidence about a decision
 *  being made after it. */
export function currentObservationGeneration(): number {
  return latest.generation;
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

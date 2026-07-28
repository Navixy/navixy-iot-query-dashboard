import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  currentObservationGeneration,
  getSessionObservation,
  subscribeToSessionObservations,
  type SessionObservation,
} from '@/components/ai-chat/sessionObservation';

/**
 * The MOUNT-LOCAL half of the composer lock, and the rule for releasing it
 * (review !62 round 6, Important 4; release added round 13, Important 2; made
 * observation-scoped round 14, Important 1).
 *
 * Reconciliation locks the composer when a failed turn came back 'received' (the
 * server took it, the reply is still coming) or 'uncertain' (its fate could not be
 * established) — a second POST then would race a turn the stateful agent may
 * already be working on. The server's own transcript cannot always show that turn,
 * which is why this exists alongside the server-derived lock rather than being
 * replaced by it.
 *
 * A LOCK IS ABOUT ONE TURN, AND ONLY LATER NEWS CAN CLEAR IT. Round 13 keyed the
 * release on the verdict STRING, which carries neither of those. So a lock taken
 * while the last read already said 'idle' was unreleasable — the next successful
 * GET returned the same string, the dependency did not change, the effect never
 * re-ran — and, in the other direction, an OLDER 'idle' reading republished into
 * the query cache after the lock was taken cancelled it, which is worse: it opens
 * the composer for a turn a fresher receipt had just proved was still running.
 *
 * Two ways out, and both are evidence rather than inference:
 *
 *  - FRESHNESS. Every reading of GET /session gets a monotonic generation at the
 *    moment it arrives (sessionObservation.ts). A lock records the generation
 *    current when it was taken, and only a reading NEWER than that may release it.
 *    An 'idle' the server proved after the lock is real news; the same value read
 *    before it is not.
 *  - IDENTITY. A lock knows the client_turn_id it was taken for. An assistant turn
 *    stamped with that id proves THAT send finished, and a finished turn cannot
 *    resume — so this holds at any generation. It is also the ONLY releaser a
 *    legacy tenant has: with no receipts table the server omits awaiting_reply
 *    entirely, the transcript fallback can answer 'awaiting' or 'unknown' but
 *    never 'idle', and round 13 left such a tenant locked until a reload even
 *    though the matching reply was sitting in the transcript.
 *
 * 'unknown' still releases nothing: the server omitting the field, or a read that
 * failed, is not evidence of an idle session, and a transcript that may itself be
 * a degraded empty buffer cannot supply it either.
 *
 * The caller MUST keep polling while `locked` — a lock whose release can only
 * arrive in a later reading, on a page that stopped reading, is the round-13
 * deadlock wearing a new hat. See AiChat's poll effect.
 */
interface HeldLock {
  /** The turn this lock is about; null when it was taken without one. */
  clientTurnId: string | null;
  /** The newest generation observed when the lock was taken. Only something
   *  strictly newer counts as news. */
  baseline: number;
}

export interface AwaitingReplyLock {
  /** True while a turn observed by THIS mount may still be running. */
  locked: boolean;
  /** Called by reconciliation for a 'received' or 'uncertain' turn. Pass the
   *  turn's client_turn_id whenever there is one — without it only the freshness
   *  rule can release the lock, which on a legacy tenant is never. */
  lock: (clientTurnId?: string | null) => void;
}

/** Does this reading release this lock? Pure, and the whole rule in one place. */
export function releasesLock(held: HeldLock, observation: SessionObservation): boolean {
  // IDENTITY — this exact send has been answered. Monotone, so any reading proves
  // it, including one older than the lock.
  if (held.clientTurnId !== null && observation.answeredTurnIds.includes(held.clientTurnId)) {
    return true;
  }
  // FRESHNESS — the server proved the session idle, in a reading taken after the
  // lock. 'unknown' is not a proof and never releases.
  return observation.verdict === 'idle' && observation.generation > held.baseline;
}

export function useAwaitingReplyLock(): AwaitingReplyLock {
  const observation = useSyncExternalStore(subscribeToSessionObservations, getSessionObservation);
  const [held, setHeld] = useState<HeldLock[]>([]);

  // Locks are tracked INDIVIDUALLY, not as one boolean: two failed turns can be
  // outstanding at once, and the identity rule proves one of them finished, not
  // both. Collapsing them would let turn B's reply open the composer while turn A
  // is still running on the agent.
  useEffect(() => {
    if (held.length === 0) return;
    const remaining = held.filter((lock) => !releasesLock(lock, observation));
    if (remaining.length !== held.length) setHeld(remaining);
  }, [held, observation]);

  const lock = useCallback((clientTurnId?: string | null) => {
    // Read the baseline HERE, not inside the updater: this is the moment the lock
    // decision is being made, and everything already observed — including the poll
    // reading that led to this call — must count as older than it.
    const baseline = currentObservationGeneration();
    setHeld((current) => [...current, { clientTurnId: clientTurnId ?? null, baseline }]);
  }, []);

  return { locked: held.length > 0, lock };
}

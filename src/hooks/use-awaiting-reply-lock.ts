import { useCallback, useEffect, useState } from 'react';
import type { AwaitingReplyVerdict } from '@/components/ai-chat/turnDelivery';

/**
 * The MOUNT-LOCAL half of the composer lock, and the rule for releasing it
 * (review !62 round 6, Important 4; release added round 13, Important 2).
 *
 * Reconciliation locks the composer when a failed turn came back 'received' (the
 * server took it, the reply is still coming) or 'uncertain' (its fate could not be
 * established) — a second POST then would race a turn the stateful agent may
 * already be working on. The server's own transcript cannot always show that turn,
 * which is why this exists alongside the server-derived lock rather than being
 * replaced by it.
 *
 * THE RELEASE IS THE POINT. This flag used to be set-only — "sticky once set: only
 * a reload clears it" — while the page ORs it with the server's verdict. So a poll
 * that came back `awaiting_reply: false`, meaning the reply had landed or the TTL
 * had written the turn off as abandoned, could not re-enable the composer: the
 * user was locked out until they navigated away or reloaded. That is exactly the
 * deadlock round 12's TTL was introduced to end, left in force for the whole of
 * the current mount.
 *
 * ONLY A PROVEN IDLE RELEASES IT. 'unknown' — the server omitting the field
 * because it has no usable receipts table or its read failed, or a legacy
 * response — holds the lock. Guessing "probably finished" from a transcript that
 * may itself be a degraded empty buffer is how the lock stops meaning anything.
 *
 * Keyed on the VERDICT, so the release fires on the TRANSITION into 'idle' rather
 * than on every refetch: a lock taken by reconciliation after an already-idle read
 * is not immediately undone by that same stale read.
 */
export interface AwaitingReplyLock {
  /** True while a turn observed by THIS mount may still be running. */
  locked: boolean;
  /** Called by reconciliation for a 'received' or 'uncertain' turn. */
  lock: () => void;
}

export function useAwaitingReplyLock(verdict: AwaitingReplyVerdict): AwaitingReplyLock {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (verdict === 'idle') setLocked(false);
  }, [verdict]);

  const lock = useCallback(() => setLocked(true), []);

  return { locked, lock };
}

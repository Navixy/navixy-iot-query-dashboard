/**
 * @vitest-environment jsdom
 *
 * review !62 round 13, Important 2.
 *
 * Reconciliation locks the composer for a 'received' or 'uncertain' turn, and the
 * flag was SET-ONLY — the comment said so outright: "sticky once set: only a
 * reload (fresh mount) clears it". AiChat ORs it with the server's verdict, so
 * once it was set, a poll that came back `awaiting_reply: false` — the reply had
 * landed, or the TTL had written the turn off as abandoned — could not re-enable
 * the composer. The user stayed locked out for the whole mount, which is the very
 * deadlock round 12's TTL was introduced to end.
 *
 * The transition these tests pin is `received/uncertain -> awaiting_reply: false`
 * WITHOUT a remount.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAwaitingReplyLock } from '@/hooks/use-awaiting-reply-lock';
import type { AwaitingReplyVerdict } from '@/components/ai-chat/turnDelivery';

function setup(initial: AwaitingReplyVerdict = 'unknown') {
  return renderHook(
    ({ verdict }: { verdict: AwaitingReplyVerdict }) => useAwaitingReplyLock(verdict),
    { initialProps: { verdict: initial } },
  );
}

describe('useAwaitingReplyLock', () => {
  it('starts unlocked', () => {
    expect(setup().result.current.locked).toBe(false);
  });

  it('locks when reconciliation says the turn may still be running', () => {
    const { result } = setup();

    act(() => result.current.lock());

    expect(result.current.locked).toBe(true);
  });

  it('RELEASES on a proven idle, with no remount', () => {
    // THE FIX. Same mount throughout: lock as 'received', then the poll returns
    // awaiting_reply: false.
    const { result, rerender } = setup('awaiting');
    act(() => result.current.lock());
    expect(result.current.locked).toBe(true);

    rerender({ verdict: 'idle' });

    expect(result.current.locked).toBe(false);
  });

  it('HOLDS the lock while the verdict is unknown', () => {
    // The server omits awaiting_reply when it has no usable receipts table or its
    // read failed. That is not permission to unlock.
    const { result, rerender } = setup('awaiting');
    act(() => result.current.lock());

    rerender({ verdict: 'unknown' });

    expect(result.current.locked).toBe(true);
  });

  it('HOLDS the lock while the server still shows the turn running', () => {
    const { result, rerender } = setup('unknown');
    act(() => result.current.lock());

    rerender({ verdict: 'awaiting' });

    expect(result.current.locked).toBe(true);
  });

  it('does not let a STALE idle read undo a lock taken after it', () => {
    // Ordering matters: the page may already be holding an 'idle' session read
    // when reconciliation classifies a turn 'uncertain'. That earlier read says
    // nothing about the turn just classified, so it must not cancel the lock.
    const { result, rerender } = setup('idle');
    rerender({ verdict: 'idle' });

    act(() => result.current.lock());

    expect(result.current.locked).toBe(true);
  });

  it('unlocks again on the NEXT transition into idle', () => {
    // The release is edge-triggered, so prove the edge can recur — a second turn
    // in the same mount must not inherit a spent release.
    const { result, rerender } = setup('idle');
    act(() => result.current.lock());
    expect(result.current.locked).toBe(true);

    rerender({ verdict: 'awaiting' });
    expect(result.current.locked).toBe(true);
    rerender({ verdict: 'idle' });

    expect(result.current.locked).toBe(false);
  });

  it('survives the round trip: lock, unknown, awaiting, idle', () => {
    const { result, rerender } = setup('unknown');
    act(() => result.current.lock());

    for (const verdict of ['unknown', 'awaiting', 'unknown'] as AwaitingReplyVerdict[]) {
      rerender({ verdict });
      expect(result.current.locked).toBe(true);
    }

    rerender({ verdict: 'idle' });
    expect(result.current.locked).toBe(false);
  });
});

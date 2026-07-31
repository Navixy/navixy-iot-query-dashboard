/**
 * @vitest-environment jsdom
 *
 * review !62 round 13, Important 2 — the release exists at all; round 14,
 * Important 1 — the release is scoped to an OBSERVATION; round 15, Important 1 &
 * 2 — that observation is ordered by DISPATCH and belongs to ONE identity.
 *
 * Round 13 keyed the release on the verdict STRING, which says neither when it
 * was read nor which turn it is about. Both directions broke, and this file pins
 * both plus the rules that replaced it:
 *
 *  - FRESHNESS: a lock taken while the last read already said 'idle' was
 *    unreleasable, because the next successful GET returned the same string and
 *    the effect dependency never changed. Locked for the whole mount.
 *  - and in reverse, an OLDER 'idle' reading republished into the query cache
 *    after the lock cancelled it — opening the composer for a turn a fresher
 *    receipt had just proved was still running. Round 14 ordered readings by
 *    ARRIVAL, which left the same hole for a slow GET dispatched before the lock.
 *  - IDENTITY: on a legacy tenant the server omits awaiting_reply entirely, so the
 *    verdict can be 'awaiting' or 'unknown' but never 'idle' — round 13 left such
 *    a mount locked until a reload even with the matching reply in the transcript.
 *
 * The ledger is module-global on purpose (see sessionObservation), so these tests
 * drive it exactly as production does: by drawing tickets and recording readings.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { releasesLock, useAwaitingReplyLock } from '@/hooks/use-awaiting-reply-lock';
import {
  beginSessionRead,
  currentReadHighWaterMark,
  getSessionObservation,
  recordSessionObservation,
  type SessionObservation,
} from '@/components/ai-chat/sessionObservation';
import type { AgentSessionResponse, AgentTurn } from '@/types/agent';

function session(overrides: Partial<AgentSessionResponse> = {}): AgentSessionResponse {
  return {
    session_id: 'sess-1',
    persisted: true,
    supports_turn_ids: true,
    messages: [],
    ...overrides,
  };
}

/** The server PROVED nothing is running. */
const idleRead = () => session({ awaiting_reply: false });
/** The server says a turn is in flight. */
const awaitingRead = () => session({ awaiting_reply: true });

const userTurn = (id: string): AgentTurn => ({ role: 'user', content: 'hi', client_turn_id: id });
const assistantTurn = (id: string): AgentTurn => ({
  role: 'assistant',
  content: 'there',
  client_turn_id: id,
});

/** A tenant with no usable receipts table: awaiting_reply is OMITTED, so the
 *  verdict comes from the transcript and can never be 'idle'. */
const legacyRead = (messages: AgentTurn[]) => session({ messages });

/** A complete read the way the query fetcher and the reconciler's poll do it:
 *  ticket drawn, request dispatched, response recorded. */
function observe(response: AgentSessionResponse) {
  act(() => {
    recordSessionObservation(beginSessionRead(), response);
  });
}

describe('useAwaitingReplyLock', () => {
  // The ledger is module-global and monotonic, so start every case from a reading
  // that releases nothing — otherwise the previous case's answered ids are still
  // the newest thing the hook can see.
  beforeEach(() => {
    recordSessionObservation(beginSessionRead(), awaitingRead());
  });

  it('starts unlocked', () => {
    expect(renderHook(() => useAwaitingReplyLock()).result.current.locked).toBe(false);
  });

  it('locks when reconciliation says the turn may still be running', () => {
    const { result } = renderHook(() => useAwaitingReplyLock());

    act(() => result.current.lock('turn-A'));

    expect(result.current.locked).toBe(true);
  });

  it('RELEASES on a fresh idle read that repeats the value already cached', () => {
    // THE ROUND-14 DEADLOCK. The page was already holding an idle read when
    // reconciliation locked; the next successful GET says idle again. Round 13 saw
    // no change in the verdict string and never re-ran its effect.
    observe(idleRead());
    const { result } = renderHook(() => useAwaitingReplyLock());
    act(() => result.current.lock('turn-A'));
    expect(result.current.locked).toBe(true);

    observe(idleRead());

    expect(result.current.locked).toBe(false);
  });

  it('does NOT release from a read DISPATCHED before the lock, however late it lands', () => {
    // THE ROUND-15 RACE. The request left before the lock existed, so the server
    // snapshot inside it predates the turn the lock is about — but round 14 gave
    // it its generation on ARRIVAL, which put it above the baseline and made a
    // stale idle look like the news that frees the composer.
    const inFlight = beginSessionRead(); // GET /session goes out...
    const { result } = renderHook(() => useAwaitingReplyLock());

    act(() => result.current.lock('turn-A')); // ...the receipt proves 'received'
    act(() => {
      recordSessionObservation(inFlight, idleRead()); // ...and only now does it land
    });

    expect(result.current.locked).toBe(true);

    // A read dispatched AFTER the lock says the same thing, and that one is news.
    observe(idleRead());

    expect(result.current.locked).toBe(false);
  });

  it('does NOT release from an idle read taken BEFORE the lock, on any re-render', () => {
    // The dangerous direction: the reconciler's poll read idle, the receipt lookup
    // AFTER it upgraded the turn to 'received', and the lock was taken on that
    // fresher evidence. Publishing the older read into the query cache re-renders
    // this mount — and must not cancel the lock.
    observe(awaitingRead());
    const { result, rerender } = renderHook(() => useAwaitingReplyLock());

    observe(idleRead()); // the poll's own GET
    act(() => result.current.lock('turn-A')); // receipt says 'received'
    rerender(); // setQueryData publishes that older GET

    expect(result.current.locked).toBe(true);
  });

  it('releases a LEGACY lock when the locked turn own reply appears', () => {
    // No receipts table: awaiting_reply is omitted throughout, so the verdict goes
    // 'awaiting' -> 'unknown' and never 'idle'. The matching assistant is the only
    // proof such a tenant can offer, and it is proof.
    observe(legacyRead([userTurn('turn-A')]));
    const { result } = renderHook(() => useAwaitingReplyLock());
    act(() => result.current.lock('turn-A'));
    expect(result.current.locked).toBe(true);

    observe(legacyRead([userTurn('turn-A'), assistantTurn('turn-A')]));

    // The verdict here really is 'unknown', not a smuggled 'idle' — the release
    // came from identity.
    expect(getSessionObservation().verdict).toBe('unknown');
    expect(result.current.locked).toBe(false);
  });

  it('HOLDS while the verdict is unknown and the locked turn is unanswered', () => {
    const { result } = renderHook(() => useAwaitingReplyLock());
    act(() => result.current.lock('turn-A'));

    // A legacy reading that settles — every id it shows is answered — but says
    // nothing about ours, which the 100-turn window may simply have evicted. That
    // is 'unknown', and 'unknown' is not permission to unlock.
    observe(legacyRead([userTurn('turn-Z'), assistantTurn('turn-Z')]));

    expect(getSessionObservation().verdict).toBe('unknown');
    expect(result.current.locked).toBe(true);
  });

  it('HOLDS while the server still shows a turn running', () => {
    const { result } = renderHook(() => useAwaitingReplyLock());
    act(() => result.current.lock('turn-A'));

    observe(awaitingRead());

    expect(result.current.locked).toBe(true);
  });

  it('releases an UNCERTAIN, id-less lock without a remount', () => {
    // 'uncertain' can arrive with no usable id (a tenant that does not round-trip
    // them). Freshness is then the only rule left, and it must still work.
    const { result } = renderHook(() => useAwaitingReplyLock());
    act(() => result.current.lock(null));
    expect(result.current.locked).toBe(true);

    observe(idleRead());

    expect(result.current.locked).toBe(false);
  });

  it('releases a lock whose reply is ALREADY in the newest reading', () => {
    // Identity is monotone: a turn cannot resume once answered, so proof from a
    // reading older than the lock still counts.
    observe(legacyRead([userTurn('turn-A'), assistantTurn('turn-A')]));
    const { result } = renderHook(() => useAwaitingReplyLock());

    act(() => result.current.lock('turn-A'));

    expect(result.current.locked).toBe(false);
  });

  it('does not let one turn reply release ANOTHER turn lock', () => {
    // Two failed turns can be outstanding at once. B being answered says nothing
    // about A, which may still be running on the stateful agent.
    const { result } = renderHook(() => useAwaitingReplyLock());
    act(() => {
      result.current.lock('turn-A');
      result.current.lock('turn-B');
    });

    observe(legacyRead([userTurn('turn-B'), assistantTurn('turn-B')]));

    expect(result.current.locked).toBe(true);

    // ...and the session going idle clears both, because that verdict is about the
    // whole session.
    observe(idleRead());

    expect(result.current.locked).toBe(false);
  });

  it('can be locked and released repeatedly in one mount', () => {
    // The release must not be a spent edge: a second turn in the same mount gets
    // the same treatment as the first.
    const { result } = renderHook(() => useAwaitingReplyLock());

    for (const turnId of ['turn-A', 'turn-B']) {
      act(() => result.current.lock(turnId));
      expect(result.current.locked).toBe(true);
      observe(awaitingRead());
      expect(result.current.locked).toBe(true);
      observe(idleRead());
      expect(result.current.locked).toBe(false);
    }
  });
});

describe('releasesLock — the rule on its own', () => {
  const EPOCH = 'epoch-1';
  const at = (ticket: number, over: Partial<SessionObservation> = {}): SessionObservation => ({
    ticket,
    epoch: EPOCH,
    verdict: 'idle',
    answeredTurnIds: [],
    ...over,
  });
  const heldAt = (baseline: number, clientTurnId: string | null = 'turn-A') => ({
    clientTurnId,
    baseline,
    epoch: EPOCH,
  });

  it('requires an idle read DISPATCHED strictly after the lock', () => {
    expect(releasesLock(heldAt(5), at(6))).toBe(true);
    expect(releasesLock(heldAt(5), at(5))).toBe(false);
    expect(releasesLock(heldAt(5), at(4))).toBe(false);
  });

  it('never releases on unknown or awaiting, however fresh', () => {
    expect(releasesLock(heldAt(1), at(99, { verdict: 'unknown' }))).toBe(false);
    expect(releasesLock(heldAt(1), at(99, { verdict: 'awaiting' }))).toBe(false);
  });

  it('releases on the locked id being answered, at any ticket', () => {
    expect(
      releasesLock(heldAt(5), at(1, { verdict: 'unknown', answeredTurnIds: ['turn-A'] })),
    ).toBe(true);
    expect(
      releasesLock(heldAt(5), at(1, { verdict: 'unknown', answeredTurnIds: ['turn-B'] })),
    ).toBe(false);
  });

  it('has no identity rule to apply when the lock carries no id', () => {
    expect(
      releasesLock(heldAt(5, null), at(1, { verdict: 'unknown', answeredTurnIds: ['turn-A'] })),
    ).toBe(false);
  });

  it('ignores a reading from ANOTHER auth epoch under BOTH rules', () => {
    // Round 15, Important 2. The previous tenant's in-flight GET can still settle
    // here; whatever it says is about their session, not this one.
    const foreign = { epoch: 'epoch-2' };
    expect(releasesLock(heldAt(5), at(6, foreign))).toBe(false);
    expect(
      releasesLock(
        heldAt(5),
        at(6, { ...foreign, verdict: 'unknown', answeredTurnIds: ['turn-A'] }),
      ),
    ).toBe(false);
    // ...and a signed-out reading is not this lock's either.
    expect(releasesLock(heldAt(5), at(6, { epoch: null }))).toBe(false);
  });
});

describe('the lock baseline', () => {
  it('covers every read already DISPATCHED when lock() is called', () => {
    observe(idleRead());
    const before = currentReadHighWaterMark();
    const { result } = renderHook(() => useAwaitingReplyLock());

    observe(idleRead());
    // A reading that lands between the mount and the lock still predates it.
    act(() => result.current.lock('turn-A'));

    expect(currentReadHighWaterMark()).toBe(before + 1);
    expect(result.current.locked).toBe(true);
  });
});

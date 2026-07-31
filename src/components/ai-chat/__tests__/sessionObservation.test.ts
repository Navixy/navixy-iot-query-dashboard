/**
 * review !62 round 14, Important 1; round 15, Important 1 & 2.
 *
 * The ledger exists because the session QUERY CACHE cannot answer "when did the
 * server last tell us something, and what did it say" — structural sharing hides a
 * repeat reading behind the original object, setQueryData republishes an old one
 * as if it were new, and the mutation's settle path synthesizes a transcript that
 * was never read from the server at all.
 *
 * These tests pin the properties the composer lock depends on: readings are
 * ordered by WHEN THEY WERE ASKED FOR rather than when they came back, a reading
 * belongs to the identity that requested it, and the snapshot reference is stable
 * between records (useSyncExternalStore requires that — an unstable getSnapshot
 * makes React re-render forever).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginSessionRead,
  currentReadHighWaterMark,
  getSessionObservation,
  recordSessionObservation,
  subscribeToSessionObservations,
} from '@/components/ai-chat/sessionObservation';
import { beginAuthSession, endAuthSession } from '@/lib/authSession';
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

/** The common case: draw and record with nothing in between. */
function read(response: AgentSessionResponse | null = session()) {
  return recordSessionObservation(beginSessionRead(), response);
}

afterEach(() => {
  endAuthSession();
});

describe('the session observation ledger', () => {
  it('orders readings by the ticket drawn at DISPATCH', () => {
    const before = currentReadHighWaterMark();

    const first = beginSessionRead();
    const second = beginSessionRead();

    expect(first.id).toBe(before + 1);
    expect(second.id).toBe(before + 2);
    // The mark moves when a request GOES OUT, so a lock taken now already
    // outranks both — neither has said anything yet.
    expect(currentReadHighWaterMark()).toBe(second.id);
  });

  it('records every reading, identical payload or not', () => {
    const first = read(session({ awaiting_reply: false }));
    const second = read(session({ awaiting_reply: false }));

    // The repeat is the whole point: two deep-equal idle reads are two separate
    // pieces of news, and React Query's structural sharing would have collapsed
    // them into one object.
    expect(second.ticket).toBeGreaterThan(first.ticket);
  });

  it('KEEPS THE NEWEST reading when an older one arrives late', () => {
    // The round-15 race at its source. Both requests are out; the older one wins
    // the race home. Ordering by arrival would leave the ledger holding the
    // staler answer — and holding it at a ticket high enough to look like news.
    const early = beginSessionRead();
    const late = beginSessionRead();

    recordSessionObservation(late, session({ awaiting_reply: true }));
    const afterOverlap = recordSessionObservation(early, session({ awaiting_reply: false }));

    expect(afterOverlap.ticket).toBe(late.id);
    expect(afterOverlap.verdict).toBe('awaiting');
    expect(getSessionObservation().ticket).toBe(late.id);
  });

  it('DROPS a reading whose auth epoch has moved on', () => {
    // clear() drops the query, not the request: the previous tenant's GET settles
    // into the next tenant's page. It is not their answer to read.
    beginAuthSession('token-a');
    const ticket = beginSessionRead();
    const observedByA = getSessionObservation();

    endAuthSession();
    beginAuthSession('token-b');
    const result = recordSessionObservation(ticket, session({ awaiting_reply: false }));

    expect(result).toBe(observedByA);
    expect(getSessionObservation()).toBe(observedByA);
  });

  it('stamps a reading with the epoch that ASKED for it', () => {
    const epoch = beginAuthSession('token-a');

    expect(read(session({ awaiting_reply: false })).epoch).toBe(epoch);
  });

  it('carries the tri-state verdict, not a boolean', () => {
    expect(read(session({ awaiting_reply: true })).verdict).toBe('awaiting');
    expect(read(session({ awaiting_reply: false })).verdict).toBe('idle');
    // Omitted: the server could not tell. Never 'idle'.
    expect(read(session()).verdict).toBe('unknown');
    expect(read(null).verdict).toBe('unknown');
  });

  it('collects the client_turn_ids that an ASSISTANT turn answered', () => {
    const messages: AgentTurn[] = [
      { role: 'user', content: 'a', client_turn_id: 'turn-A' },
      { role: 'assistant', content: 'reply a', client_turn_id: 'turn-A' },
      { role: 'user', content: 'b', client_turn_id: 'turn-B' },
    ];

    const observation = read(session({ messages }));

    // turn-B is asked but unanswered; the user turn's own id must not count as
    // proof of its own completion.
    expect(observation.answeredTurnIds).toEqual(['turn-A']);
  });

  it('keeps one stable snapshot reference between records', () => {
    read(session({ awaiting_reply: false }));
    const snapshot = getSessionObservation();

    expect(getSessionObservation()).toBe(snapshot);

    read(session({ awaiting_reply: false }));

    expect(getSessionObservation()).not.toBe(snapshot);
  });

  it('notifies subscribers until they unsubscribe', () => {
    let notifications = 0;
    const unsubscribe = subscribeToSessionObservations(() => {
      notifications += 1;
    });

    read();
    read();
    expect(notifications).toBe(2);

    unsubscribe();
    read();

    expect(notifications).toBe(2);
  });

  it('does not notify for a reading it dropped', () => {
    const stale = beginSessionRead();
    read();
    let notifications = 0;
    const unsubscribe = subscribeToSessionObservations(() => {
      notifications += 1;
    });

    recordSessionObservation(stale, session({ awaiting_reply: false }));

    expect(notifications).toBe(0);
    unsubscribe();
  });

  it('survives a listener that unsubscribes while being notified', () => {
    let other = 0;
    const unsubscribeSelf = subscribeToSessionObservations(() => unsubscribeSelf());
    const unsubscribeOther = subscribeToSessionObservations(() => {
      other += 1;
    });

    read();

    expect(other).toBe(1);
    unsubscribeOther();
  });
});

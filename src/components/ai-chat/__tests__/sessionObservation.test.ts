/**
 * review !62 round 14, Important 1.
 *
 * The ledger exists because the session QUERY CACHE cannot answer "when did the
 * server last tell us something, and what did it say" — structural sharing hides a
 * repeat reading behind the original object, setQueryData republishes an old one
 * as if it were new, and the mutation's settle path synthesizes a transcript that
 * was never read from the server at all. These tests pin the properties the
 * composer lock depends on: the generation is monotonic, it is minted per RECORD,
 * and the snapshot reference is stable between records (useSyncExternalStore
 * requires that — an unstable getSnapshot makes React re-render forever).
 */
import { describe, expect, it } from 'vitest';
import {
  currentObservationGeneration,
  getSessionObservation,
  recordSessionObservation,
  subscribeToSessionObservations,
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

describe('the session observation ledger', () => {
  it('mints a NEW generation for every reading, identical payload or not', () => {
    const before = currentObservationGeneration();

    const first = recordSessionObservation(session({ awaiting_reply: false }));
    const second = recordSessionObservation(session({ awaiting_reply: false }));

    // The repeat is the whole point: two deep-equal idle reads are two separate
    // pieces of news, and React Query's structural sharing would have collapsed
    // them into one object.
    expect(first.generation).toBe(before + 1);
    expect(second.generation).toBe(before + 2);
  });

  it('carries the tri-state verdict, not a boolean', () => {
    expect(recordSessionObservation(session({ awaiting_reply: true })).verdict).toBe('awaiting');
    expect(recordSessionObservation(session({ awaiting_reply: false })).verdict).toBe('idle');
    // Omitted: the server could not tell. Never 'idle'.
    expect(recordSessionObservation(session()).verdict).toBe('unknown');
    expect(recordSessionObservation(null).verdict).toBe('unknown');
  });

  it('collects the client_turn_ids that an ASSISTANT turn answered', () => {
    const messages: AgentTurn[] = [
      { role: 'user', content: 'a', client_turn_id: 'turn-A' },
      { role: 'assistant', content: 'reply a', client_turn_id: 'turn-A' },
      { role: 'user', content: 'b', client_turn_id: 'turn-B' },
    ];

    const observation = recordSessionObservation(session({ messages }));

    // turn-B is asked but unanswered; the user turn's own id must not count as
    // proof of its own completion.
    expect(observation.answeredTurnIds).toEqual(['turn-A']);
  });

  it('keeps one stable snapshot reference between records', () => {
    recordSessionObservation(session({ awaiting_reply: false }));
    const snapshot = getSessionObservation();

    expect(getSessionObservation()).toBe(snapshot);

    recordSessionObservation(session({ awaiting_reply: false }));

    expect(getSessionObservation()).not.toBe(snapshot);
  });

  it('reports the newest generation as the lock baseline', () => {
    const recorded = recordSessionObservation(session({ awaiting_reply: true }));

    expect(currentObservationGeneration()).toBe(recorded.generation);
    expect(getSessionObservation()).toBe(recorded);
  });

  it('notifies subscribers until they unsubscribe', () => {
    let notifications = 0;
    const unsubscribe = subscribeToSessionObservations(() => {
      notifications += 1;
    });

    recordSessionObservation(session());
    recordSessionObservation(session());
    expect(notifications).toBe(2);

    unsubscribe();
    recordSessionObservation(session());

    expect(notifications).toBe(2);
  });

  it('survives a listener that unsubscribes while being notified', () => {
    let other = 0;
    const unsubscribeSelf = subscribeToSessionObservations(() => unsubscribeSelf());
    const unsubscribeOther = subscribeToSessionObservations(() => {
      other += 1;
    });

    recordSessionObservation(session());

    expect(other).toBe(1);
    unsubscribeOther();
  });
});

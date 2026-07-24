import { describe, it, expect } from 'vitest';
import {
  appendUncertainNotice,
  classifyTurnDelivery,
  countMatchingUserTurns,
  locksComposerAwaitingReply,
  reconcileOutcome,
  UNCERTAIN_DELIVERY_NOTICE,
} from '../turnDelivery';
import type { AgentTurn, ChatBubble } from '@/types/agent';

const seqId = () => {
  let n = 0;
  return () => `id-${n++}`;
};

const user = (content: string): AgentTurn => ({ role: 'user', content });
const userWithId = (content: string, client_turn_id: string): AgentTurn => ({
  role: 'user', content, client_turn_id,
});
const assistant = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});
const assistantError = (content: string): AgentTurn => ({
  role: 'assistant', type: 'error', content, result: null,
});

// The content fallback (no id available): clientTurnId is null AND no history
// turn carries one, so classifyTurnDelivery uses content + occurrence baseline.
describe('classifyTurnDelivery — content fallback when no id is available (review !62 rounds 3–4)', () => {
  it('completed: the sent message sits in the transcript with an assistant turn after it', () => {
    const history = [user('old'), assistant('old reply'), user('probe'), assistant('built it')];
    expect(classifyTurnDelivery(history, 'probe', null)).toBe('completed');
  });

  it('received: the sent message is the last turn — server got it, no reply yet', () => {
    const history = [user('old'), assistant('old reply'), user('probe')];
    expect(classifyTurnDelivery(history, 'probe', null)).toBe('received');
  });

  it('lost: the sent message never reached the transcript', () => {
    const history = [user('old'), assistant('old reply')];
    expect(classifyTurnDelivery(history, 'probe', null)).toBe('lost');
  });

  it('lost on an empty transcript', () => {
    expect(classifyTurnDelivery([], 'probe', null)).toBe('lost');
  });

  it('a persisted in-band error turn counts as the answer — completed, not received', () => {
    const history = [user('probe'), assistantError('validation failed')];
    expect(classifyTurnDelivery(history, 'probe', null)).toBe('completed');
  });

  it('turns from a concurrent tab after ours still classify ours as completed', () => {
    const history = [
      user('probe'), assistant('built it'),
      user('other tab prompt'), assistant('other tab reply'),
    ];
    expect(classifyTurnDelivery(history, 'probe', null)).toBe('completed');
  });

  it('an assistant-only tail does not match a user message (role matters)', () => {
    const history = [user('old'), assistant('probe')];
    expect(classifyTurnDelivery(history, 'probe', null)).toBe('lost');
  });

  describe('send-time occurrence baseline (review !62 round 4, Important 2)', () => {
    it('a repeated prompt whose SECOND send is lost is classified lost, not absorbed by the first', () => {
      // The user already sent "refresh" once (answered). They send it again and
      // THAT POST is lost, so the server transcript still holds exactly one
      // "refresh". With a baseline of 1, one occurrence is NOT a new one → lost,
      // so the draft comes back instead of the new command vanishing.
      const history = [user('refresh'), assistant('done'), user('other'), assistant('ok')];
      expect(classifyTurnDelivery(history, 'refresh', null, 1)).toBe('lost');
    });

    it('the same repeated prompt is completed when the server DID record the new occurrence', () => {
      const history = [
        user('refresh'), assistant('done'),
        user('refresh'), assistant('done again'),
      ];
      expect(classifyTurnDelivery(history, 'refresh', null, 1)).toBe('completed');
    });

    it('received: the new repeated occurrence landed but has no reply yet', () => {
      const history = [user('refresh'), assistant('done'), user('refresh')];
      expect(classifyTurnDelivery(history, 'refresh', null, 1)).toBe('received');
    });

    it('a baseline larger than the matches present is still lost (window may have slid)', () => {
      const history = [user('refresh'), assistant('done')];
      expect(classifyTurnDelivery(history, 'refresh', null, 2)).toBe('lost');
    });

    it('completed-vs-received keys off the NEWEST matching user turn, not the oldest', () => {
      // baseline 1: the newest "refresh" (index 2) is ours; it has a reply after.
      const history = [user('refresh'), user('refresh'), assistant('answer to the 2nd')];
      expect(classifyTurnDelivery(history, 'refresh', null, 1)).toBe('completed');
    });
  });
});

// The PRIMARY path (review !62 round 6): a client_turn_id is present AND the
// server round-trips ids, so matching is deterministic — content and baseline are
// ignored entirely.
describe('classifyTurnDelivery — deterministic id match (review !62 round 6, findings 4/5)', () => {
  it('completed: our id is in the transcript with an assistant turn after it', () => {
    const history = [userWithId('build', 'tid-1'), assistant('built it')];
    expect(classifyTurnDelivery(history, 'build', 'tid-1')).toBe('completed');
  });

  it('received: our id is present with no assistant after it — agent may still be working', () => {
    const history = [userWithId('build', 'tid-1')];
    expect(classifyTurnDelivery(history, 'build', 'tid-1')).toBe('received');
  });

  it('lost: the server round-trips ids (others are present) but not ours', () => {
    const history = [userWithId('earlier', 'tid-0'), assistant('done')];
    expect(classifyTurnDelivery(history, 'build', 'tid-missing')).toBe('lost');
  });

  it('a concurrent tab\'s identical prompt does NOT absorb ours — the id disambiguates', () => {
    // Content matching would call this completed (an identical "refresh" with a
    // reply after it). By id, ours (tid-mine) never landed → lost, so the draft
    // is safely restored instead of silently dropped.
    const history = [userWithId('refresh', 'tid-other'), assistant('other tab reply')];
    expect(classifyTurnDelivery(history, 'refresh', 'tid-mine')).toBe('lost');
  });

  it('our reply is matched even when a concurrent identical prompt lands after ours', () => {
    const history = [
      userWithId('refresh', 'tid-mine'), assistant('our reply'),
      userWithId('refresh', 'tid-other'),
    ];
    expect(classifyTurnDelivery(history, 'refresh', 'tid-mine')).toBe('completed');
  });

  it('falls back to content when the transcript carries NO ids (older schema)', () => {
    // We sent an id, but the server (older 002) did not persist any — so no user
    // turn has one. Trust content instead of calling a delivered turn lost.
    const history = [user('build'), assistant('built it')];
    expect(classifyTurnDelivery(history, 'build', 'tid-1')).toBe('completed');
  });
});

describe('locksComposerAwaitingReply (review !62 round 6, Important 4)', () => {
  it('locks while a delivered turn has no reply yet (received)', () => {
    expect(locksComposerAwaitingReply('delivered', 'received')).toBe(true);
  });

  it('locks while delivery is uncertain, regardless of the delivery value', () => {
    expect(locksComposerAwaitingReply('uncertain', 'lost')).toBe(true);
    expect(locksComposerAwaitingReply('uncertain', 'received')).toBe(true);
  });

  it('does NOT lock once the reply is present (completed)', () => {
    expect(locksComposerAwaitingReply('delivered', 'completed')).toBe(false);
  });

  it('does NOT lock when the turn provably never arrived (confirmed-lost)', () => {
    expect(locksComposerAwaitingReply('confirmed-lost', 'lost')).toBe(false);
  });
});

describe('reconcileOutcome — trusting a poll verdict (review !62 round 5, Important 3)', () => {
  it('delivered: a positive verdict is trusted whenever any GET saw it', () => {
    expect(reconcileOutcome(true, 'completed', true)).toBe('delivered');
    expect(reconcileOutcome(true, 'received', true)).toBe('delivered');
    // Even if the very last probe then failed, a turn seen delivered cannot un-happen.
    expect(reconcileOutcome(true, 'completed', false)).toBe('delivered');
  });

  it('confirmed-lost: the MOST RECENT probe succeeded and still showed the turn absent', () => {
    expect(reconcileOutcome(true, 'lost', true)).toBe('confirmed-lost');
  });

  it('uncertain: an early "lost" that later FAILED probes never re-confirmed (the overtake race)', () => {
    // First GET overtook the backend appendTurns and read the turn absent; the
    // two later polls failed, so the absence was never re-confirmed after the
    // overtake window. Restoring the draft here could double-feed the agent.
    expect(reconcileOutcome(true, 'lost', false)).toBe('uncertain');
  });

  it('uncertain: no GET ever succeeded', () => {
    expect(reconcileOutcome(false, 'lost', false)).toBe('uncertain');
  });
});

describe('appendUncertainNotice — preserve the prompt across remount (review !62 round 5, Critical 1)', () => {
  it('re-materializes the message on a REMOUNT (empty transcript), then the notice', () => {
    const out = appendUncertainNotice([], 'my careful prompt', seqId());
    expect(out.map((b) => [b.role, b.text])).toEqual([
      ['user', 'my careful prompt'],
      ['assistant', UNCERTAIN_DELIVERY_NOTICE],
    ]);
    expect(out[1].isError).toBe(true);
  });

  it('does NOT duplicate the message on the ORIGINAL mount (optimistic bubble already last)', () => {
    const prev: ChatBubble[] = [{ id: 'a', role: 'user', text: 'my careful prompt' }];
    const out = appendUncertainNotice(prev, 'my careful prompt', seqId());
    expect(out.filter((b) => b.role === 'user')).toHaveLength(1);
    expect(out.map((b) => b.role)).toEqual(['user', 'assistant']);
  });

  it('re-adds when the last user bubble is a DIFFERENT message', () => {
    const prev: ChatBubble[] = [
      { id: 'a', role: 'user', text: 'older prompt' },
      { id: 'b', role: 'assistant', text: 'reply' },
    ];
    const out = appendUncertainNotice(prev, 'my careful prompt', seqId());
    expect(out.filter((b) => b.role === 'user').map((b) => b.text)).toEqual([
      'older prompt',
      'my careful prompt',
    ]);
  });
});

describe('countMatchingUserTurns', () => {
  it('counts only user turns of the exact content', () => {
    const history = [
      user('refresh'), assistant('refresh'), user('refresh'), user('other'),
    ];
    expect(countMatchingUserTurns(history, 'refresh')).toBe(2);
    expect(countMatchingUserTurns(history, 'other')).toBe(1);
    expect(countMatchingUserTurns(history, 'missing')).toBe(0);
    expect(countMatchingUserTurns([], 'refresh')).toBe(0);
  });
});

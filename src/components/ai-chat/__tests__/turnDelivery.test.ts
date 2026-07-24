import { describe, it, expect } from 'vitest';
import {
  appendUncertainNotice,
  applyReceiptToDelivery,
  classifyTurnDelivery,
  countMatchingUserTurns,
  locksComposerAwaitingReply,
  reconcileOutcome,
  sessionAwaitsReply,
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
const assistantWithId = (content: string, client_turn_id: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null, client_turn_id,
});
const assistantError = (content: string): AgentTurn => ({
  role: 'assistant', type: 'error', content, result: null,
});

// The content fallback: supportsTurnIds is FALSE (older 002), so classifyTurnDelivery
// uses content + occurrence baseline regardless of any id.
describe('classifyTurnDelivery — content fallback when the server does not support ids (review !62 rounds 3–4)', () => {
  it('completed: the sent message sits in the transcript with an assistant turn after it', () => {
    const history = [user('old'), assistant('old reply'), user('probe'), assistant('built it')];
    expect(classifyTurnDelivery(history, 'probe', null, false)).toBe('completed');
  });

  it('received: the sent message is the last turn — server got it, no reply yet', () => {
    const history = [user('old'), assistant('old reply'), user('probe')];
    expect(classifyTurnDelivery(history, 'probe', null, false)).toBe('received');
  });

  it('lost: the sent message never reached the transcript', () => {
    const history = [user('old'), assistant('old reply')];
    expect(classifyTurnDelivery(history, 'probe', null, false)).toBe('lost');
  });

  it('lost on an empty transcript', () => {
    expect(classifyTurnDelivery([], 'probe', null, false)).toBe('lost');
  });

  it('a persisted in-band error turn counts as the answer — completed, not received', () => {
    const history = [user('probe'), assistantError('validation failed')];
    expect(classifyTurnDelivery(history, 'probe', null, false)).toBe('completed');
  });

  it('an assistant-only tail does not match a user message (role matters)', () => {
    const history = [user('old'), assistant('probe')];
    expect(classifyTurnDelivery(history, 'probe', null, false)).toBe('lost');
  });

  describe('send-time occurrence baseline (review !62 round 4, Important 2)', () => {
    it('a repeated prompt whose SECOND send is lost is classified lost, not absorbed by the first', () => {
      const history = [user('refresh'), assistant('done'), user('other'), assistant('ok')];
      expect(classifyTurnDelivery(history, 'refresh', null, false, 1)).toBe('lost');
    });

    it('the same repeated prompt is completed when the server DID record the new occurrence', () => {
      const history = [
        user('refresh'), assistant('done'),
        user('refresh'), assistant('done again'),
      ];
      expect(classifyTurnDelivery(history, 'refresh', null, false, 1)).toBe('completed');
    });

    it('received: the new repeated occurrence landed but has no reply yet', () => {
      const history = [user('refresh'), assistant('done'), user('refresh')];
      expect(classifyTurnDelivery(history, 'refresh', null, false, 1)).toBe('received');
    });

    it('a baseline larger than the matches present is still lost (window may have slid)', () => {
      const history = [user('refresh'), assistant('done')];
      expect(classifyTurnDelivery(history, 'refresh', null, false, 2)).toBe('lost');
    });
  });
});

// The PRIMARY path (review !62 round 7): supports_turn_ids is TRUE, so matching is
// deterministic by the exact user↔reply pair — content and baseline are ignored.
describe('classifyTurnDelivery — exact-pair id match (review !62 round 7, findings 3/5a)', () => {
  it('completed: an ASSISTANT turn carries our id', () => {
    const history = [userWithId('build', 'tid-1'), assistantWithId('built it', 'tid-1')];
    expect(classifyTurnDelivery(history, 'build', 'tid-1', true)).toBe('completed');
  });

  it('received: our user id is present but no assistant carries it yet', () => {
    const history = [userWithId('build', 'tid-1')];
    expect(classifyTurnDelivery(history, 'build', 'tid-1', true)).toBe('received');
  });

  it('lost: the server supports ids but neither a user nor an assistant carries ours', () => {
    const history = [userWithId('earlier', 'tid-0'), assistantWithId('done', 'tid-0')];
    expect(classifyTurnDelivery(history, 'build', 'tid-missing', true)).toBe('lost');
  });

  it('finding 3: a concurrent turn\'s reply landing FIRST does not complete ours', () => {
    // [user A, user B, reply B] — the old "any assistant after our user" rule
    // returned completed for A while A was still running. Matching the exact PAIR,
    // A has no reply carrying tid-A yet → received.
    const history = [
      userWithId('build A', 'tid-A'),
      userWithId('build B', 'tid-B'), assistantWithId('reply B', 'tid-B'),
    ];
    expect(classifyTurnDelivery(history, 'build A', 'tid-A', true)).toBe('received');
  });

  it('our reply is matched even interleaved among concurrent turns', () => {
    const history = [
      userWithId('refresh', 'tid-mine'),
      userWithId('refresh', 'tid-other'), assistantWithId('other reply', 'tid-other'),
      assistantWithId('our reply', 'tid-mine'),
    ];
    expect(classifyTurnDelivery(history, 'refresh', 'tid-mine', true)).toBe('completed');
  });

  it('finding 5a: capability comes from the FLAG, not a visible id — no id support → content fallback', () => {
    // We sent an id, but supports_turn_ids is false (older 002). Trust content
    // instead of calling a delivered turn lost.
    const history = [user('build'), assistant('built it')];
    expect(classifyTurnDelivery(history, 'build', 'tid-1', false)).toBe('completed');
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

describe('applyReceiptToDelivery — durable receipt reconfirmation (review !62 round 7, finding 5b)', () => {
  it('upgrades a lost verdict to completed when the receipt says answered', () => {
    expect(applyReceiptToDelivery('lost', { status: 'answered', supported: true })).toBe('completed');
  });

  it('upgrades a lost verdict to received when the receipt says received', () => {
    expect(applyReceiptToDelivery('lost', { status: 'received', supported: true })).toBe('received');
  });

  it('keeps lost when a SUPPORTED receipt is unknown — genuinely never delivered', () => {
    expect(applyReceiptToDelivery('lost', { status: 'unknown', supported: true })).toBe('lost');
  });

  it('leaves the transcript verdict untouched when receipts are unsupported', () => {
    expect(applyReceiptToDelivery('lost', { status: 'unknown', supported: false })).toBe('lost');
    expect(applyReceiptToDelivery('lost', null)).toBe('lost');
  });

  it('never reconsiders a positive verdict (a receipt cannot un-happen a delivery)', () => {
    expect(applyReceiptToDelivery('completed', { status: 'unknown', supported: true })).toBe('completed');
    expect(applyReceiptToDelivery('received', { status: 'unknown', supported: true })).toBe('received');
  });
});

describe('sessionAwaitsReply — server-derived lock (review !62 round 7, finding 4)', () => {
  it('true when the newest turn is a user turn (a turn is still in flight)', () => {
    expect(sessionAwaitsReply([user('a'), assistant('b'), user('c')])).toBe(true);
  });

  it('false when the newest turn is an assistant reply', () => {
    expect(sessionAwaitsReply([user('a'), assistant('b')])).toBe(false);
  });

  it('false on an empty transcript', () => {
    expect(sessionAwaitsReply([])).toBe(false);
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

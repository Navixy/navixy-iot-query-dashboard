import { describe, it, expect } from 'vitest';
import { classifyTurnDelivery, countMatchingUserTurns } from '../turnDelivery';
import type { AgentTurn } from '@/types/agent';

const user = (content: string): AgentTurn => ({ role: 'user', content });
const assistant = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});
const assistantError = (content: string): AgentTurn => ({
  role: 'assistant', type: 'error', content, result: null,
});

describe('classifyTurnDelivery — lost-response triage (review !62 rounds 3–4)', () => {
  it('completed: the sent message sits in the transcript with an assistant turn after it', () => {
    const history = [user('old'), assistant('old reply'), user('probe'), assistant('built it')];
    expect(classifyTurnDelivery(history, 'probe')).toBe('completed');
  });

  it('received: the sent message is the last turn — server got it, no reply yet', () => {
    const history = [user('old'), assistant('old reply'), user('probe')];
    expect(classifyTurnDelivery(history, 'probe')).toBe('received');
  });

  it('lost: the sent message never reached the transcript', () => {
    const history = [user('old'), assistant('old reply')];
    expect(classifyTurnDelivery(history, 'probe')).toBe('lost');
  });

  it('lost on an empty transcript', () => {
    expect(classifyTurnDelivery([], 'probe')).toBe('lost');
  });

  it('a persisted in-band error turn counts as the answer — completed, not received', () => {
    const history = [user('probe'), assistantError('validation failed')];
    expect(classifyTurnDelivery(history, 'probe')).toBe('completed');
  });

  it('turns from a concurrent tab after ours still classify ours as completed', () => {
    const history = [
      user('probe'), assistant('built it'),
      user('other tab prompt'), assistant('other tab reply'),
    ];
    expect(classifyTurnDelivery(history, 'probe')).toBe('completed');
  });

  it('an assistant-only tail does not match a user message (role matters)', () => {
    const history = [user('old'), assistant('probe')];
    expect(classifyTurnDelivery(history, 'probe')).toBe('lost');
  });

  describe('send-time occurrence baseline (review !62 round 4, Important 2)', () => {
    it('a repeated prompt whose SECOND send is lost is classified lost, not absorbed by the first', () => {
      // The user already sent "refresh" once (answered). They send it again and
      // THAT POST is lost, so the server transcript still holds exactly one
      // "refresh". With a baseline of 1, one occurrence is NOT a new one → lost,
      // so the draft comes back instead of the new command vanishing.
      const history = [user('refresh'), assistant('done'), user('other'), assistant('ok')];
      expect(classifyTurnDelivery(history, 'refresh', 1)).toBe('lost');
    });

    it('the same repeated prompt is completed when the server DID record the new occurrence', () => {
      const history = [
        user('refresh'), assistant('done'),
        user('refresh'), assistant('done again'),
      ];
      expect(classifyTurnDelivery(history, 'refresh', 1)).toBe('completed');
    });

    it('received: the new repeated occurrence landed but has no reply yet', () => {
      const history = [user('refresh'), assistant('done'), user('refresh')];
      expect(classifyTurnDelivery(history, 'refresh', 1)).toBe('received');
    });

    it('a baseline larger than the matches present is still lost (window may have slid)', () => {
      const history = [user('refresh'), assistant('done')];
      expect(classifyTurnDelivery(history, 'refresh', 2)).toBe('lost');
    });

    it('completed-vs-received keys off the NEWEST matching user turn, not the oldest', () => {
      // baseline 1: the newest "refresh" (index 2) is ours; it has a reply after.
      const history = [user('refresh'), user('refresh'), assistant('answer to the 2nd')];
      expect(classifyTurnDelivery(history, 'refresh', 1)).toBe('completed');
    });
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

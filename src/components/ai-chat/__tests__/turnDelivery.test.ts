import { describe, it, expect } from 'vitest';
import { classifyTurnDelivery } from '../turnDelivery';
import type { AgentTurn } from '@/types/agent';

const user = (content: string): AgentTurn => ({ role: 'user', content });
const assistant = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});
const assistantError = (content: string): AgentTurn => ({
  role: 'assistant', type: 'error', content, result: null,
});

describe('classifyTurnDelivery — lost-response triage (review !62 round 3, Important 2)', () => {
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
    // The server recorded the turn ending in type:'error'; that IS its outcome,
    // and the history renderer shows it as the same destructive bubble.
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

  it('ACCEPTED BIAS, pinned: a truly lost re-send of an older completed message classifies as completed', () => {
    // The newest content match wins. If the user re-sent the exact text of an
    // older turn and THAT send never arrived, the older completed turn answers
    // for it: no draft comes back, at the cost of a retype. Uncertainty must
    // resolve away from feeding the stateful agent twice, never toward it.
    const history = [user('probe'), assistant('answered long ago')];
    expect(classifyTurnDelivery(history, 'probe')).toBe('completed');
  });
});

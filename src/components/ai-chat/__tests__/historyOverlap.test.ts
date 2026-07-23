import { describe, it, expect } from 'vitest';
import { trimHistoryOverlap } from '../historyOverlap';
import type { AgentTurn, ChatBubble } from '@/types/agent';

const user = (content: string): AgentTurn => ({ role: 'user', content });
const assistant = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});

const liveUser = (text: string, id = 'live-u'): ChatBubble => ({ id, role: 'user', text });
const liveAssistant = (text: string, id = 'live-a'): ChatBubble => ({
  id, role: 'assistant', text,
});
const liveError = (text: string, id = 'live-e'): ChatBubble => ({
  id, role: 'assistant', text, isError: true,
});

describe('trimHistoryOverlap — the late-history seam (review !62 round 2, Important 5)', () => {
  it('returns history untouched when nothing overlaps (GET serialized before the POST)', () => {
    const history = [user('old prompt'), assistant('old reply')];
    expect(trimHistoryOverlap(history, [liveUser('new prompt')])).toEqual(history);
  });

  it('trims the in-flight user turn the server persisted at POST receipt', () => {
    const history = [user('old prompt'), assistant('old reply'), user('new prompt')];
    expect(trimHistoryOverlap(history, [liveUser('new prompt')])).toEqual([
      user('old prompt'), assistant('old reply'),
    ]);
  });

  it('trims the whole finished exchange when the reply landed before the slow GET', () => {
    const history = [
      user('old prompt'), assistant('old reply'),
      user('new prompt'), assistant('new reply'),
    ];
    const live = [liveUser('new prompt'), liveAssistant('new reply', 'live-1')];
    expect(trimHistoryOverlap(history, live)).toEqual([
      user('old prompt'), assistant('old reply'),
    ]);
  });

  it('handles several serialized exchanges sent before the GET resolved', () => {
    const history = [
      user('old'), assistant('reply'),
      user('first'), assistant('first reply'), user('second'),
    ];
    const live = [
      liveUser('first', 'l0'), liveAssistant('first reply', 'l1'), liveUser('second', 'l2'),
    ];
    expect(trimHistoryOverlap(history, live)).toEqual([user('old'), assistant('reply')]);
  });

  it('a transport-error bubble never blocks trimming the user turn before it', () => {
    // The server never held the error turn, so only the user turn overlaps.
    const history = [user('old prompt'), assistant('old reply'), user('doomed prompt')];
    const live = [liveUser('doomed prompt'), liveError('The request failed. Please try again.')];
    expect(trimHistoryOverlap(history, live)).toEqual([
      user('old prompt'), assistant('old reply'),
    ]);
  });

  it('matches by role as well as text — same words from the other side do not trim', () => {
    const history = [user('old'), assistant('ok')];
    expect(trimHistoryOverlap(history, [liveUser('ok')])).toEqual(history);
  });

  it('can consume the whole history when live covers it', () => {
    const history = [user('hello')];
    const live = [liveUser('hello'), liveAssistant('hi there')];
    expect(trimHistoryOverlap(history, live)).toEqual([]);
  });

  it('empty inputs are no-ops', () => {
    expect(trimHistoryOverlap([], [liveUser('x')])).toEqual([]);
    const history = [user('a')];
    expect(trimHistoryOverlap(history, [])).toEqual(history);
  });

  it('ACCEPTED COST, pinned: an old conversation genuinely ending with the re-sent text is trimmed too', () => {
    // The previous transcript really ended with 'again?', and the user's first
    // send this mount is also 'again?'. The suffix/prefix rule cannot tell a
    // look-alike from a duplicate, and hiding the look-alike for one mount
    // beats rendering a certain duplicate. The next mount reconciles from the
    // server and shows both.
    const history = [user('old prompt'), assistant('old reply'), user('again?')];
    expect(trimHistoryOverlap(history, [liveUser('again?')])).toEqual([
      user('old prompt'), assistant('old reply'),
    ]);
  });
});

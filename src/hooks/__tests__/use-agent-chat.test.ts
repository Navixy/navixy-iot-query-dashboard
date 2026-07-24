import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import {
  agentChatMutationKey,
  agentSessionQueryKey,
  createAgentChatContext,
  settleChatTurnIntoSessionCache,
} from '../use-agent-chat';
import { beginAuthSession, endAuthSession } from '@/lib/authSession';
import { apiService } from '@/services/api';
import type { AgentChatResponse, AgentSessionResponse, AgentTurn } from '@/types/agent';

// The hooks themselves need React + AuthContext; the exported settle/context
// helpers do not. Mocking both modules keeps this suite headless (vitest node
// env, no jsdom) and keeps AuthContext's import graph (Dexie, react-router)
// out of a unit test about cache semantics.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, authSessionId: null }),
}));
vi.mock('@/services/api', () => ({
  apiService: { agentChat: vi.fn(), getAgentSession: vi.fn() },
}));

const user = (content: string): AgentTurn => ({ role: 'user', content });
const assistant = (content: string): AgentTurn => ({
  role: 'assistant', type: 'question', content, result: null,
});

const session = (messages: AgentTurn[], session_id = 'session-1'): AgentSessionResponse => ({
  session_id, persisted: true, messages,
});

const reply = (message: string, session_id = 'session-1'): AgentChatResponse => ({
  session_id, type: 'question', message, result: null,
});

beforeEach(() => {
  endAuthSession();
  vi.mocked(apiService.getAgentSession).mockReset();
});

describe('createAgentChatContext — send-time occurrence baseline (review !62 round 4, Important 2)', () => {
  it('records how many identical user turns already existed at send time', async () => {
    const epoch = beginAuthSession();
    const client = new QueryClient();
    client.setQueryData(
      agentSessionQueryKey(epoch),
      session([user('refresh'), assistant('done'), user('other')]),
    );
    expect((await createAgentChatContext(client, 'refresh')).priorSameContentUserTurns).toBe(1);
    expect((await createAgentChatContext(client, 'other')).priorSameContentUserTurns).toBe(1);
    expect((await createAgentChatContext(client, 'brand new')).priorSameContentUserTurns).toBe(0);
    // The cache was populated, so no session read was needed to baseline.
    expect(apiService.getAgentSession).not.toHaveBeenCalled();
  });

  it('awaits the in-flight session read for an authoritative baseline when the cache is empty (review !62 round 5, Important 4)', async () => {
    // The composer is usable during the initial GET, so a turn can be sent
    // before the session cache exists. A baseline of 0 there lets a repeat of an
    // EXISTING turn be absorbed by the older occurrence if this send is lost.
    // The context must instead reflect the server's true pre-send history.
    const epoch = beginAuthSession();
    const client = new QueryClient();
    vi.mocked(apiService.getAgentSession).mockResolvedValue({
      data: session([user('refresh'), assistant('done')]),
    });

    const context = await createAgentChatContext(client, 'refresh');

    expect(apiService.getAgentSession).toHaveBeenCalledTimes(1);
    expect(context.priorSameContentUserTurns).toBe(1);
    // And the resolved read now backs the settle reference-identity guard too.
    expect(client.getQueryData(agentSessionQueryKey(epoch))).toBe(context.snapshotAtSend);
  });

  it('falls back to a 0 baseline when the session read fails (the residual a client turn id would close)', async () => {
    beginAuthSession();
    const client = new QueryClient(); // no session cache
    vi.mocked(apiService.getAgentSession).mockResolvedValue({
      error: { message: 'network down' },
    });
    const context = await createAgentChatContext(client, 'refresh');
    expect(context.snapshotAtSend).toBeNull();
    expect(context.priorSameContentUserTurns).toBe(0);
  });
});

describe('settleChatTurnIntoSessionCache — guarded write', () => {
  it('appends the turn pair and adopts the returned session_id when the cache is untouched since send', async () => {
    const epoch = beginAuthSession();
    const client = new QueryClient();
    client.setQueryData(agentSessionQueryKey(epoch), session([user('hi'), assistant('hello')]));

    const context = await createAgentChatContext(client, 'build a dashboard');
    settleChatTurnIntoSessionCache(client, context, 'build a dashboard', reply('Which range?', 'session-2'));

    const after = client.getQueryData<AgentSessionResponse>(agentSessionQueryKey(epoch));
    expect(after?.session_id).toBe('session-2');
    expect(after?.messages).toEqual([
      user('hi'), assistant('hello'),
      user('build a dashboard'), assistant('Which range?'),
    ]);
  });

  it('reconciles from the server instead of inventing a cache entry when none exists at settle time', async () => {
    const epoch = beginAuthSession();
    const client = new QueryClient();
    // The empty-cache baseline read fails fast (no mock impl) → snapshot stays null.
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const context = await createAgentChatContext(client, 'hello'); // no session cache yet
    settleChatTurnIntoSessionCache(client, context, 'hello', reply('hi'));

    expect(client.getQueryData(agentSessionQueryKey(epoch))).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentSessionQueryKey(epoch) });
  });

  it('drops a reply that settles after sign-out, even when the next sign-in holds a same-shaped cache (review !62 round 2, Critical 2)', async () => {
    // Sender A: turn goes out under epoch A with a 2-message transcript.
    const epochA = beginAuthSession();
    const client = new QueryClient();
    const epochAKey = agentSessionQueryKey(epochA);
    client.setQueryData(epochAKey, session([user('secret A prompt'), assistant('A reply')]));
    const contextA = await createAgentChatContext(client, 'secret A prompt 2');

    // A signs out mid-turn; B signs in and loads their OWN 2-message transcript
    // — the same length, which is what defeated a shape-based guard.
    endAuthSession();
    client.clear();
    const epochB = beginAuthSession();
    const bTranscript = session([user('B prompt'), assistant('B reply')], 'session-B');
    client.setQueryData(agentSessionQueryKey(epochB), bTranscript);

    const invalidate = vi.spyOn(client, 'invalidateQueries');
    settleChatTurnIntoSessionCache(client, contextA, 'secret A prompt 2', reply('late A reply'));

    // B's cache is byte-identical; nothing was written under A's key; and no
    // invalidation ran on A's behalf (it would refetch under B's session).
    expect(client.getQueryData(agentSessionQueryKey(epochB))).toEqual(bTranscript);
    expect(client.getQueryData(epochAKey)).toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not re-append the user turn when a mid-turn refetch slides the 100-turn window (review !62 round 2, Important 3)', async () => {
    const epoch = beginAuthSession();
    const client = new QueryClient();
    const key = agentSessionQueryKey(epoch);

    // A transcript pinned at the backend's cap: GET /session returns newest 100
    // (chatStore MAX_TURNS), so from here on every refetch keeps length 100.
    const capped = session(
      Array.from({ length: 100 }, (_, i) =>
        i % 2 === 0 ? user(`turn-${i}`) : assistant(`turn-${i}`),
      ),
    );
    client.setQueryData(key, capped);
    const context = await createAgentChatContext(client, 'in-flight prompt');

    // Mid-turn, a mount refetch lands: the server persisted the user turn at
    // POST receipt, so the newest-100 window DROPPED turn-0 and gained the
    // in-flight prompt — SAME length, moved content. This is the case a
    // length-based baseline cannot see.
    const slid = session([...capped.messages.slice(1), user('in-flight prompt')]);
    client.setQueryData(key, slid);

    const invalidate = vi.spyOn(client, 'invalidateQueries');
    settleChatTurnIntoSessionCache(client, context, 'in-flight prompt', reply('done'));

    // A length-based guard appended here: 102 messages with the prompt twice.
    const after = client.getQueryData<AgentSessionResponse>(key);
    expect(after?.messages).toHaveLength(100);
    expect(after?.messages.filter((m) => m.content === 'in-flight prompt')).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
  });

  it('still appends when a refetch delivered byte-identical content (structural sharing keeps the snapshot reference)', async () => {
    const epoch = beginAuthSession();
    const client = new QueryClient();
    const key = agentSessionQueryKey(epoch);
    client.setQueryData(key, session([user('hi'), assistant('hello')]));
    const context = await createAgentChatContext(client, 'next');

    // A refetch that changes nothing: TanStack's structural sharing keeps the
    // ORIGINAL object when the incoming data is deep-equal, so the send-time
    // reference still matches and the append proceeds. This pins the library
    // behavior the reference guard relies on — if a TanStack upgrade stops
    // sharing, this fails loudly instead of silently degrading every
    // uneventful refetch into a reconcile round-trip.
    client.setQueryData(key, session([user('hi'), assistant('hello')]));

    settleChatTurnIntoSessionCache(client, context, 'next', reply('sure'));
    expect(client.getQueryData<AgentSessionResponse>(key)?.messages).toHaveLength(4);
  });

  it('a turn sent with no auth session at all never touches any cache', async () => {
    const client = new QueryClient(); // no beginAuthSession()
    const context = await createAgentChatContext(client, 'hello');
    expect(context.authSessionAtSend).toBeNull();

    beginAuthSession(); // someone signs in before it settles
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    settleChatTurnIntoSessionCache(client, context, 'hello', reply('hi'));

    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('failed chat turns in the mutation cache (review !62 round 2, Important 4)', () => {
  it('a turn that fails after its page unmounted keeps its draft and error readable, scoped to its epoch', async () => {
    // AiChat surfaces failures by READING the mutation cache, not from
    // mutate-level onError — this pins the mechanism that design relies on:
    // the mutation entry, its variables and its error survive the observer
    // (the page) going away mid-flight.
    const epochA = beginAuthSession();
    const client = new QueryClient();
    const observer = new MutationObserver(client, {
      mutationKey: agentChatMutationKey(epochA),
      retry: false,
      networkMode: 'always',
      mutationFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('network dropped');
      },
    });

    // The page subscribes on mount, sends...
    const unsubscribe = observer.subscribe(() => {});
    const inFlight = observer
      .mutate({ session_id: null, message: 'my careful draft' })
      .catch(() => undefined);
    // ...and unmounts mid-turn (navigation). The observer goes away; the
    // mutation does not.
    unsubscribe();
    await inFlight;

    const failed = client.getMutationCache().findAll({
      mutationKey: agentChatMutationKey(epochA),
      status: 'error',
    });
    expect(failed).toHaveLength(1);
    expect(failed[0].state.variables).toEqual({ session_id: null, message: 'my careful draft' });
    expect((failed[0].state.error as Error).message).toBe('network dropped');

    // Another sign-in's filter must not see this sign-in's failure.
    expect(
      client.getMutationCache().findAll({
        mutationKey: agentChatMutationKey('another-epoch'),
        status: 'error',
      }),
    ).toHaveLength(0);
  });
});

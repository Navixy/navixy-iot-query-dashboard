/**
 * @vitest-environment jsdom
 *
 * review !62 rounds 13–14 — the composer lock, driven through the REAL PAGE.
 *
 * This replaces the source-level `aiChatPoll.wiring.test.ts`. The pure rules
 * (`shouldPollSession`, `releasesLock`) and the hook are unit-tested where they
 * live; what only a rendered AiChat can show is the thing round 14 actually
 * broke — a page that takes a lock, stops reading, and therefore never learns
 * what would release it. So these cases assert on what the user experiences:
 * whether the composer is usable, and whether the page is still polling.
 *
 * Everything on the chat path is real: use-agent-chat, turnDelivery, the
 * observation ledger, the lock hook, ChatComposer, ChatTranscript. Only the app
 * shell (AppLayout — sidebar, header, menu queries), the auth context and the
 * HTTP client are replaced, because none of them is part of what is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beginAuthSession, endAuthSession } from '@/lib/authSession';
import type { AgentSessionResponse, AgentTurn } from '@/types/agent';

const authState = vi.hoisted(() => ({
  current: {
    user: null as unknown,
    loading: false,
    authSessionId: null as string | null,
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

vi.mock('@/components/layout/AppLayout', () => ({
  // The app shell (sidebar, header, menu queries) is not what is under test.
  AppLayout: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/services/api', () => ({
  apiService: {
    getAgentSession: vi.fn(),
    agentChat: vi.fn(),
    getAgentTurnStatus: vi.fn(),
  },
}));

const { apiService } = await import('@/services/api');
const AiChat = (await import('@/pages/AiChat')).default;

const TAB_TOKEN = 'tab-token';

/** The session payload the next GET /session will return. Mutated between
 *  phases so a test can say "and now the server answers differently". */
let sessionPayload: AgentSessionResponse;

function session(overrides: Partial<AgentSessionResponse> = {}): AgentSessionResponse {
  return {
    session_id: 'sess-1',
    persisted: true,
    supports_turn_ids: true,
    messages: [],
    ...overrides,
  };
}

const userTurn = (id: string, content = 'build me a dashboard'): AgentTurn => ({
  role: 'user',
  content,
  client_turn_id: id,
});
const assistantTurn = (id: string): AgentTurn => ({
  role: 'assistant',
  type: 'question',
  content: 'here you go',
  result: null,
  client_turn_id: id,
});

function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // createElement rather than JSX: this repo's vitest config has no react
  // plugin, so esbuild compiles JSX with the classic runtime and would need
  // React in scope. The two other .tsx suites do the same.
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, null, createElement(AiChat)),
    ),
  );
}

/** Advance fake timers AND drain the microtask queue — the reconciler is an
 *  async loop, so both are needed for it to make progress. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const composer = () =>
  screen.getByLabelText('Message to the AI assistant') as HTMLTextAreaElement;

/** What the user can actually see and do. */
const composerIsUsable = () => !composer().disabled;

/** Type a message and press Send. */
function send(text = 'build me a dashboard') {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

/** The client_turn_id the page minted for the (single) turn it sent. */
function sentTurnId(): string {
  const [request] = vi.mocked(apiService.agentChat).mock.calls[0] as [
    { client_turn_id?: string | null },
  ];
  const id = request.client_turn_id;
  if (!id) throw new Error('the page sent no client_turn_id');
  return id;
}

const getSessionCalls = () => vi.mocked(apiService.getAgentSession).mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('auth_token', TAB_TOKEN);
  const epoch = beginAuthSession(TAB_TOKEN);
  authState.current = {
    user: { id: 'u1', email: 'u@example.com', role: 'editor' },
    loading: false,
    authSessionId: epoch,
  };

  sessionPayload = session();
  vi.mocked(apiService.getAgentSession).mockReset();
  vi.mocked(apiService.getAgentSession).mockImplementation(async () => ({
    data: sessionPayload,
  }));
  vi.mocked(apiService.agentChat).mockReset();
  vi.mocked(apiService.getAgentTurnStatus).mockReset();
  // Default: a tenant with no durable receipts, where 'unknown' is uninformative
  // and the transcript verdict stands. Cases that need a receipt override it.
  vi.mocked(apiService.getAgentTurnStatus).mockResolvedValue({
    data: { status: 'unknown', supported: false },
  });
});

afterEach(() => {
  cleanup();
  endAuthSession();
  vi.useRealTimers();
});

describe('AiChat — the composer lock, end to end', () => {
  it('re-enables the composer when a LATER read repeats the idle the page already had', async () => {
    // THE ROUND-14 DEADLOCK, as a user would meet it. The page is already
    // holding an idle read when a turn's transport dies; the reconciler finds
    // the turn delivered-but-unanswered and locks. Every later read says idle
    // again — the same value — and round 13 could neither see that as news nor
    // fetch it in the first place, so the composer stayed dead for the whole
    // mount.
    sessionPayload = session({ awaiting_reply: false });
    vi.mocked(apiService.agentChat).mockRejectedValue(new Error('network down'));

    renderChat();
    await settle();
    expect(composerIsUsable()).toBe(true);

    send();
    await settle();
    // The server took the turn: it is in the transcript with no reply yet, and
    // the TTL has not yet written it off — so awaiting_reply is still false.
    sessionPayload = session({ awaiting_reply: false, messages: [userTurn('placeholder')] });
    await settle(3000);
    sessionPayload = session({ awaiting_reply: false, messages: [userTurn(sentTurnId())] });

    expect(composerIsUsable()).toBe(false);

    // Round 14's other half: the page must still be READING. Nothing else can
    // produce the observation that frees it.
    const callsWhileLocked = getSessionCalls();
    await settle(5000);
    expect(getSessionCalls()).toBeGreaterThan(callsWhileLocked);

    expect(composerIsUsable()).toBe(true);
  });

  it('keeps the composer locked when the reconciler republishes its OWN older read', async () => {
    // The dangerous direction. The poll reads idle and finds nothing; the
    // receipt lookup AFTER it proves the turn was received; the lock is taken on
    // that fresher evidence — and then the older idle response is written into
    // the query cache, where round 13 mistook it for news and unlocked.
    sessionPayload = session({ messages: [] }); // awaiting_reply omitted -> unknown
    vi.mocked(apiService.agentChat).mockRejectedValue(new Error('network down'));
    vi.mocked(apiService.getAgentTurnStatus).mockResolvedValue({
      data: { status: 'received', supported: true },
    });

    renderChat();
    await settle();
    send();
    await settle();
    // Every probe succeeds, says the session is idle, and does not show the turn
    // — the transcript window has not caught up with it.
    sessionPayload = session({ awaiting_reply: false, messages: [] });
    await settle(3000);

    expect(vi.mocked(apiService.getAgentTurnStatus)).toHaveBeenCalled();
    expect(composerIsUsable()).toBe(false);

    // And it is held, not stuck: the next reading is genuinely newer than the
    // lock, so the same value now frees it.
    await settle(5000);

    expect(composerIsUsable()).toBe(true);
  });

  it('frees a LEGACY tenant the moment the locked turn own reply appears', async () => {
    // No receipts table, so awaiting_reply is omitted from every response and no
    // reading can ever say 'idle'. Round 13 left this composer disabled until a
    // reload even though the matching assistant was sitting in the transcript.
    sessionPayload = session({ messages: [] });
    vi.mocked(apiService.agentChat).mockRejectedValue(new Error('network down'));

    renderChat();
    await settle();
    send();
    await settle();
    sessionPayload = session({ messages: [userTurn('placeholder')] });
    await settle(3000);
    const turnId = sentTurnId();
    sessionPayload = session({ messages: [userTurn(turnId)] });

    expect(composerIsUsable()).toBe(false);

    // The agent finishes and the reply lands, stamped with the turn's own id.
    sessionPayload = session({ messages: [userTurn(turnId), assistantTurn(turnId)] });
    await settle(5000);

    expect(composerIsUsable()).toBe(true);
  });

  it('keeps the composer locked while the server still shows the turn running', async () => {
    // The counterweight: proving the release works is only half of it. A reading
    // that still shows a turn in flight must not free anything.
    sessionPayload = session({ messages: [] });
    vi.mocked(apiService.agentChat).mockRejectedValue(new Error('network down'));

    renderChat();
    await settle();
    send();
    await settle();
    sessionPayload = session({ awaiting_reply: true, messages: [userTurn('placeholder')] });
    await settle(3000);
    sessionPayload = session({ awaiting_reply: true, messages: [userTurn(sentTurnId())] });

    expect(composerIsUsable()).toBe(false);

    await settle(15000);

    expect(composerIsUsable()).toBe(false);
  });

  it('does not lock the composer at all when the turn provably completed', async () => {
    // A delivered AND answered turn is not a reason to lock, so nothing here
    // should depend on a release arriving.
    sessionPayload = session({ awaiting_reply: false, messages: [] });
    vi.mocked(apiService.agentChat).mockRejectedValue(new Error('response lost'));

    renderChat();
    await settle();
    send();
    await settle();
    sessionPayload = session({
      awaiting_reply: false,
      messages: [userTurn('placeholder'), assistantTurn('placeholder')],
    });
    await settle(1000);
    const turnId = sentTurnId();
    sessionPayload = session({
      awaiting_reply: false,
      messages: [userTurn(turnId), assistantTurn(turnId)],
    });
    await settle(3000);

    expect(composerIsUsable()).toBe(true);
  });

  it('stops polling once nothing is locked', async () => {
    // The poll is not free. With no lock and an idle server it must go quiet,
    // or every open chat page bills a request every 5 seconds forever.
    sessionPayload = session({ awaiting_reply: false, messages: [] });

    renderChat();
    await settle();
    const settledCalls = getSessionCalls();

    await settle(30000);

    expect(getSessionCalls()).toBe(settledCalls);
  });
});

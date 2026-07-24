/**
 * @vitest-environment jsdom
 *
 * Cross-tab identity binding on the send path (review !62 round 8, finding 1).
 * The chat POST binds THIS TAB's anchor token, and onMutate rejects before the
 * POST when the origin-wide localStorage token has diverged from it (a tab that
 * was already stale when the user hit send). mutationFn rejects a bound-null
 * anchor rather than falling back to shared storage. jsdom for localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  agentSessionQueryKey,
  createAgentChatContext,
  useAgentChatMutation,
} from '../use-agent-chat';
import { beginAuthSession, endAuthSession } from '@/lib/authSession';
import { apiService } from '@/services/api';
import type { AgentSessionResponse } from '@/types/agent';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authSessionId: 'epoch-1' }),
}));
vi.mock('@/services/api', () => ({
  apiService: { agentChat: vi.fn(), getAgentSession: vi.fn() },
}));

const session = (): AgentSessionResponse => ({
  session_id: 's', persisted: true, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', type: 'question', content: 'hello', result: null }],
});

beforeEach(() => {
  localStorage.clear();
  endAuthSession();
  vi.mocked(apiService.agentChat).mockReset();
  vi.mocked(apiService.getAgentSession).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('createAgentChatContext — tab-anchored identity guard (round 8, finding 1)', () => {
  it('resolves when localStorage still matches the tab anchor (healthy tab)', async () => {
    const epoch = beginAuthSession('token-A');
    localStorage.setItem('auth_token', 'token-A');
    const client = new QueryClient();
    client.setQueryData(agentSessionQueryKey(epoch), session()); // cached → no await

    await expect(createAgentChatContext(client, 'next')).resolves.toBeTruthy();
    // Healthy send needs no session read.
    expect(apiService.getAgentSession).not.toHaveBeenCalled();
  });

  it('rejects when the origin-wide token diverged from the tab anchor (stale tab)', async () => {
    const epoch = beginAuthSession('token-A'); // this tab authenticated as A
    localStorage.setItem('auth_token', 'token-B'); // another tab signed in as B
    const client = new QueryClient();
    client.setQueryData(agentSessionQueryKey(epoch), session());

    await expect(createAgentChatContext(client, 'A prompt')).rejects.toThrow(/session/i);
  });
});

describe('useAgentChatMutation — bound-null anchor rejects, never falls back (finding 1)', () => {
  it('does not POST when the bound token is null (torn-down / signed-out tab)', async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useAgentChatMutation(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ session_id: null, message: 'hi', authToken: null }),
      ).rejects.toThrow(/signed in/i);
    });
    // The whole point: no request went out under a fallback localStorage token.
    expect(apiService.agentChat).not.toHaveBeenCalled();
  });
});

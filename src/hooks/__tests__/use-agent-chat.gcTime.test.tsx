/**
 * @vitest-environment jsdom
 *
 * Pins the mutation's gcTime (review !62 round 6, Important 3). The reconciler
 * deliberately KEEPS a failed turn whose delivery is uncertain, but
 * useMutationState only subscribes to the cache — it attaches no observer — so
 * an unobserved kept mutation is evicted by TanStack's default 5-minute gcTime
 * once the page unmounts, silently losing the message. This test fails loudly if
 * the Infinity setting is ever dropped.
 *
 * jsdom is scoped to this file via the pragma above (renderHook needs a DOM).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAgentChatMutation } from '../use-agent-chat';
import { apiService } from '@/services/api';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authSessionId: 'epoch-1' }),
}));
vi.mock('@/services/api', () => ({
  apiService: { agentChat: vi.fn(), getAgentSession: vi.fn() },
}));

describe('useAgentChatMutation — gcTime', () => {
  beforeEach(() => {
    vi.mocked(apiService.agentChat).mockReset();
    vi.mocked(apiService.getAgentSession).mockReset();
  });

  it('configures gcTime: Infinity so a kept turn is never garbage-collected', async () => {
    vi.mocked(apiService.agentChat).mockResolvedValue({
      data: { session_id: 's1', type: 'question', message: 'hi', result: null },
    });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(() => useAgentChatMutation(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ session_id: null, message: 'hi' });
    });

    const mutations = client.getMutationCache().getAll();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].options.gcTime).toBe(Infinity);
  });
});

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/services/api';
import type {
  AgentChatRequest,
  AgentChatResponse,
  AgentSessionResponse,
  AgentTurn,
} from '@/types/agent';

/**
 * Query key for the agent session read (GET /api/agent/session). Shared between
 * the session query and the chat mutation's cache write below.
 */
export const AGENT_SESSION_QUERY_KEY = ['agent', 'session'] as const;

/**
 * Loads the agent chat session: the server-authoritative session_id, the
 * persistence flag and the rehydrated transcript (DO-313).
 */
export function useAgentSession() {
  return useQuery<AgentSessionResponse>({
    queryKey: AGENT_SESSION_QUERY_KEY,
    queryFn: async () => {
      const response = await apiService.getAgentSession();
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    // retry: false — for a DIFFERENT reason than the mutation's below: a failed
    // session read must not delay a usable page by three retries. The page is
    // fully functional without history (the composer never gates on this query
    // — see AiChat), so fail fast into the empty state instead.
    retry: false,
    // Load-bearing (B5-R4): the transcript is a mount-time history snapshot
    // plus the bubbles produced live in that mount. A window-focus refetch
    // would deliver history that already contains the live turns (the
    // mutation's onSuccess writes them into this cache) and invite rendering
    // them twice. Alt-tab away and back must not refetch.
    //
    // No staleTime, deliberately: a fresh mount must always refetch so turns
    // appended while this page was unmounted are picked up from the server.
    refetchOnWindowFocus: false,
  });
}

/**
 * Sends one chat turn (POST /api/agent/chat). The caller owns session_id
 * threading and transcript state; this hook owns transport and the session
 * cache write.
 */
export function useAgentChatMutation() {
  const queryClient = useQueryClient();

  return useMutation<AgentChatResponse, Error, AgentChatRequest>({
    mutationFn: async (params) => {
      const response = await apiService.agentChat(params);
      // Throw on response.error so onError/onSuccess split cleanly: transport
      // failures and non-200 statuses land in onError; everything the server
      // answered 200 with — including the in-band type:'error' — lands in
      // onSuccess (D14).
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data!;
    },
    // retry: false — for a DIFFERENT reason than the session query's above: a
    // chat turn is not idempotent. A retried POST /chat re-sends the user's
    // message into a STATEFUL Bedrock session (D19), double-feeding the
    // agent's server-side conversation memory and double-appending the
    // transcript (R20).
    retry: false,
    // Cache-write placement option (b): write the new turns into the session
    // query's cache from the mutation's own onSuccess, not a shared
    // MutationCache handler. Hook-level callbacks belong to the mutation, not
    // the component, so this fires even when the page unmounted mid-turn —
    // which is what makes navigating away and back non-destructive (R26): the
    // next mount reads these turns from the cache instead of losing the
    // assistant turn the server produced while the page was gone.
    onSuccess: (data, variables) => {
      queryClient.setQueryData<AgentSessionResponse>(AGENT_SESSION_QUERY_KEY, (prev) => {
        // No cache entry (the session read failed or has not completed):
        // leave the cache absent rather than synthesizing an entry — we would
        // have to invent `persisted`, and the next mount's refetch gets the
        // truth from the server anyway.
        if (!prev) return undefined;
        const userTurn: AgentTurn = { role: 'user', content: variables.message };
        const assistantTurn: AgentTurn =
          data.type === 'result'
            ? { role: 'assistant', type: 'result', content: data.message, result: data.result }
            : { role: 'assistant', type: data.type, content: data.message, result: null };
        return {
          ...prev,
          session_id: data.session_id,
          messages: [...prev.messages, userTurn, assistantTurn],
        };
      });
    },
  });
}

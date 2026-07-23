import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
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
 *
 * SCOPED BY USER ID (review !62, major 3): the QueryClient is a module
 * singleton that outlives sign-out, so an identity-free key would hand user
 * A's cached transcript to user B signing in on the same tab. signOut also
 * clears the whole query cache (AuthContext), but the scoped key keeps this
 * correct even for identity switches that skip signOut.
 */
export const agentSessionQueryKey = (userId: string | null | undefined) =>
  ['agent', 'session', userId ?? 'anonymous'] as const;

/**
 * Mutation key for chat turns. Exists so AiChat can derive pending state
 * ACROSS remounts via useMutationState: useMutation's own isPending is
 * per-observer, so a page that unmounts mid-turn and remounts would otherwise
 * see isPending === false while the 7-36 s turn is still in flight — no typing
 * indicator, composer enabled, and a re-send double-feeding the stateful
 * Bedrock session (review !62, major 1; the same hazard R20/D19 guard).
 */
export const AGENT_CHAT_MUTATION_KEY = ['agent', 'chat'] as const;

/**
 * Loads the agent chat session: the server-authoritative session_id, the
 * persistence flag and the rehydrated transcript (DO-313).
 */
export function useAgentSession() {
  const { user } = useAuth();

  return useQuery<AgentSessionResponse>({
    queryKey: agentSessionQueryKey(user?.id),
    // Without a user there is no identity to scope by and no token worth
    // spending a 401 on — the page redirects to /login anyway.
    enabled: !!user,
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
  const { user } = useAuth();
  // Captured at render, so the callbacks below write under the identity that
  // sent the turn even if sign-out races the reply.
  const sessionKey = agentSessionQueryKey(user?.id);

  return useMutation<AgentChatResponse, Error, AgentChatRequest, { messagesAtSend: number | null }>({
    mutationKey: AGENT_CHAT_MUTATION_KEY,
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
    // Snapshot the transcript length at send time. The backend persists the
    // user turn at POST receipt — BEFORE the agent call (routes/agent.ts) — so
    // any session refetch that resolves while the turn is in flight already
    // ends with that turn. onSuccess compares against this snapshot to decide
    // between appending and reconciling (review !62, major 2).
    onMutate: () => ({
      messagesAtSend:
        queryClient.getQueryData<AgentSessionResponse>(sessionKey)?.messages
          .length ?? null,
    }),
    // Cache-write placement option (b): write the new turns into the session
    // query's cache from the mutation's own onSuccess, not a shared
    // MutationCache handler. Hook-level callbacks belong to the mutation, not
    // the component, so this fires even when the page unmounted mid-turn —
    // which is what makes navigating away and back non-destructive (R26): the
    // next mount reads these turns from the cache instead of losing the
    // assistant turn the server produced while the page was gone.
    onSuccess: (data, variables, context) => {
      const prev = queryClient.getQueryData<AgentSessionResponse>(sessionKey);
      // Append ONLY when the cache is exactly as it was at send time. If it is
      // absent (the session read failed or has not completed — synthesizing an
      // entry would mean inventing `persisted`), or a mid-turn refetch landed
      // (its payload already contains the user turn the server persisted at
      // receipt, so a blind append would duplicate it), reconcile from the
      // server instead of guessing at a merge.
      if (prev && context && context.messagesAtSend === prev.messages.length) {
        const userTurn: AgentTurn = { role: 'user', content: variables.message };
        const assistantTurn: AgentTurn =
          data.type === 'result'
            ? { role: 'assistant', type: 'result', content: data.message, result: data.result }
            : { role: 'assistant', type: data.type, content: data.message, result: null };
        queryClient.setQueryData<AgentSessionResponse>(sessionKey, {
          ...prev,
          session_id: data.session_id,
          messages: [...prev.messages, userTurn, assistantTurn],
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: sessionKey });
      }
    },
  });
}

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { getAuthSessionId } from '@/lib/authSession';
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
 * SCOPED BY THE AUTH-SESSION EPOCH (review !62 round 2, Critical 2), not by
 * user.id: ids are the tenant database's own users.id — unique only within that
 * tenant, so user 7 of tenant A and user 7 of tenant B collide on one machine.
 * The epoch (src/lib/authSession.ts) is opaque and unique per sign-in, so keys
 * can never collide across identities on one tab — including two consecutive
 * sign-ins of the same user. signOut also clears the whole query cache
 * (AuthContext), but clear() cannot stop in-flight callbacks; the epoch both
 * scopes the keys and powers the stale-session guard in
 * settleChatTurnIntoSessionCache.
 */
export const agentSessionQueryKey = (authSessionId: string | null) =>
  ['agent', 'session', authSessionId ?? 'anonymous'] as const;

/**
 * Mutation key for chat turns — same epoch scope, same reason. It exists so
 * AiChat can derive pending/failed state ACROSS remounts via useMutationState:
 * useMutation's own isPending is per-observer, so a page that unmounts mid-turn
 * and remounts would otherwise see isPending === false while the 7-36 s turn is
 * still in flight — no typing indicator, composer enabled, and a re-send
 * double-feeding the stateful Bedrock session (review !62, major 1; the same
 * hazard R20/D19 guard). The epoch in the key keeps one sign-in's turns
 * invisible to the next sign-in's filters.
 */
export const agentChatMutationKey = (authSessionId: string | null) =>
  ['agent', 'chat', authSessionId ?? 'anonymous'] as const;

/**
 * Everything the settled callbacks need, captured AT SEND TIME. It travels with
 * the mutation (onMutate context), so it survives page unmounts and sign-outs —
 * unlike anything closed over from a component render.
 */
export interface AgentChatMutationContext {
  /** The auth-session epoch under which the turn was sent. Compared against the
   *  CURRENT epoch when the turn settles: a mismatch means the sender signed
   *  out (and possibly someone else signed in) while the turn was in flight,
   *  and the reply must not touch any cache. */
  authSessionAtSend: string | null;
  /** The session cache OBJECT as it was at send time — the reconciliation
   *  baseline for the guarded write below. Held by REFERENCE, never by shape:
   *  the backend caps GET /session at the newest 100 turns, so a mid-turn
   *  refetch at the cap SLIDES the window — drops the oldest turn, gains the
   *  just-persisted user turn — and the length comes back unchanged while the
   *  content moved (review !62 round 2, Important 3). */
  snapshotAtSend: AgentSessionResponse | null;
}

/** onMutate body, exported for tests. */
export function createAgentChatContext(queryClient: QueryClient): AgentChatMutationContext {
  const authSessionAtSend = getAuthSessionId();
  return {
    authSessionAtSend,
    snapshotAtSend:
      queryClient.getQueryData<AgentSessionResponse>(agentSessionQueryKey(authSessionAtSend)) ??
      null,
  };
}

/**
 * Hook-level onSuccess body, exported for tests: write the settled turn into the
 * session query's cache — or reconcile from the server when the cache moved
 * under us — under the identity that SENT the turn.
 *
 * STALE AUTH SESSION FIRST (review !62 round 2, Critical 2): hook-level
 * callbacks run even after queryClient.clear() removed the mutation — TanStack
 * v5 cannot cancel an executing mutation. If the epoch changed since send, the
 * sender is signed out; whatever cache exists now belongs to someone else and
 * must not be touched — not even an invalidation, which would refetch under the
 * NEXT identity's key on this turn's behalf.
 */
export function settleChatTurnIntoSessionCache(
  queryClient: QueryClient,
  context: AgentChatMutationContext,
  message: string,
  data: AgentChatResponse,
): void {
  if (context.authSessionAtSend === null || context.authSessionAtSend !== getAuthSessionId()) {
    return;
  }
  const sessionKey = agentSessionQueryKey(context.authSessionAtSend);
  const prev = queryClient.getQueryData<AgentSessionResponse>(sessionKey);
  // Append ONLY when the cache object IS the send-time snapshot. Reference
  // identity is exact here BECAUSE of structural sharing: a refetch whose
  // payload is deep-equal keeps the original object (append stays cheap), and
  // ANY content change — including the capped-window slide that keeps the
  // length at 100 while the turns move — produces a new one. If the reference
  // moved, or the cache is absent (the session read failed or has not
  // completed — synthesizing an entry would mean inventing `persisted`),
  // reconcile from the server instead of guessing at a merge: a mid-turn
  // refetch already contains the user turn the server persisted at receipt,
  // so a blind append would duplicate it (review !62 round 2, Important 3).
  if (prev && context.snapshotAtSend === prev) {
    const userTurn: AgentTurn = { role: 'user', content: message };
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
}

/**
 * Loads the agent chat session: the server-authoritative session_id, the
 * persistence flag and the rehydrated transcript (DO-313).
 */
export function useAgentSession() {
  const { user, authSessionId } = useAuth();

  return useQuery<AgentSessionResponse>({
    queryKey: agentSessionQueryKey(authSessionId),
    // Without an authenticated session there is no identity to scope by and no
    // token worth spending a 401 on — the page redirects to /login anyway.
    enabled: !!user && authSessionId !== null,
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
  const { authSessionId } = useAuth();

  return useMutation<AgentChatResponse, Error, AgentChatRequest, AgentChatMutationContext>({
    mutationKey: agentChatMutationKey(authSessionId),
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
    // Fail fast when offline instead of pausing (review !62): the default
    // 'online' mode holds the mutation in isPending with no request in flight
    // — the typing indicator runs forever, the 190 s transport ceiling never
    // starts, and nothing tells the user why. 'always' lets fetch fail
    // immediately, which lands in the mutation cache's error state and renders
    // the standard in-line error bubble with the draft restored.
    networkMode: 'always',
    // Capture the send-time identity and reconciliation baseline. The backend
    // persists the user turn at POST receipt — BEFORE the agent call
    // (routes/agent.ts) — so any session refetch that resolves while the turn
    // is in flight already ends with that turn; settle uses the baseline to
    // decide between appending and reconciling (review !62, major 2).
    onMutate: () => createAgentChatContext(queryClient),
    // Cache-write placement option (b): write the new turns into the session
    // query's cache from the mutation's own onSuccess, not a shared
    // MutationCache handler. Hook-level callbacks belong to the mutation, not
    // the component, so this fires even when the page unmounted mid-turn —
    // which is what makes navigating away and back non-destructive (R26): the
    // next mount reads these turns from the cache instead of losing the
    // assistant turn the server produced while the page was gone.
    onSuccess: (data, variables, context) => {
      if (!context) return;
      settleChatTurnIntoSessionCache(queryClient, context, variables.message, data);
    },
  });
}

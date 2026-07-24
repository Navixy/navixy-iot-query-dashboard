import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { getAuthSessionId, getAuthToken, getTabSessionToken } from '@/lib/authSession';
import { apiService } from '@/services/api';
import { countMatchingUserTurns, sessionAwaitsReply } from '@/components/ai-chat/turnDelivery';
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
  /** How many user turns with THIS turn's exact content the client already knew
   *  about at send time — the occurrence baseline the lost-response reconciler
   *  needs so a repeated prompt is not absorbed by an older identical turn
   *  (review !62 round 4, Important 2; see classifyTurnDelivery). Derived from
   *  snapshotAtSend, so it is 0 when the session read had not yet resolved. */
  priorSameContentUserTurns: number;
}

/** The GET /session fetcher, shared by the session query and the baseline
 *  read below so both throw on response.error identically. */
export async function fetchAgentSession(): Promise<AgentSessionResponse> {
  const response = await apiService.getAgentSession();
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.data!;
}

/** onMutate body, exported for tests. Receives the turn's message so it can
 *  record the send-time occurrence baseline for that exact content.
 *
 *  ASYNC because the baseline must be AUTHORITATIVE (review !62 round 5,
 *  Important 4): the composer is usable while the initial GET is still in
 *  flight, so a turn can be sent before the session cache exists. Baselining
 *  against an empty cache (0) there is unsound — if this send is lost and the
 *  server already holds an identical earlier turn, the reconciler would see
 *  that old occurrence and call the lost send 'completed', silently dropping
 *  it. When the snapshot is absent we therefore AWAIT the session read
 *  (ensureQueryData dedups onto the in-flight GET — no extra round-trip in the
 *  common case) to capture the true pre-send transcript before the POST fires.
 *  A failed read leaves the baseline 0 — the acknowledged residual a stable
 *  client turn id would close (see classifyTurnDelivery).
 *
 *  REJECT-BEFORE-POST (review !62 round 6, Critical 1): making this async opened
 *  a window where the awaited read spans a sign-out/sign-in. api.ts's
 *  getAuthHeaders reads localStorage.auth_token at REQUEST time, so if the turn
 *  were allowed to proceed after the identity flipped, mutationFn would POST it
 *  under the NEW identity's token — A's prompt sent as B. queryClient.clear()
 *  cannot cancel an executing mutation, and settleChatTurnIntoSessionCache runs
 *  too late (the cross-identity write already happened server-side). So after
 *  the await we re-check both the epoch (catches same-tab sign-out/in) and the
 *  token (catches a cross-tab origin-wide swap that leaves this tab's epoch
 *  intact); on any change we THROW. A rejected onMutate makes TanStack skip
 *  mutationFn entirely — the POST never fires under the wrong identity. */
export async function createAgentChatContext(
  queryClient: QueryClient,
  message: string,
): Promise<AgentChatMutationContext> {
  const authSessionAtSend = getAuthSessionId();
  // The token THIS TAB authenticated with — the fixed anchor the POST binds to
  // (round 8, finding 1), NOT a fresh localStorage read. A tab that was already
  // stale when the user hit send (another tab swapped the origin-wide token
  // before the send began) reads the successor's token from localStorage but its
  // anchor is still its own; comparing the two below catches that.
  const tabTokenAtSend = getTabSessionToken();
  const sessionKey = agentSessionQueryKey(authSessionAtSend);
  let snapshotAtSend =
    queryClient.getQueryData<AgentSessionResponse>(sessionKey) ?? null;
  const awaitedSessionRead = snapshotAtSend === null && authSessionAtSend !== null;
  if (awaitedSessionRead) {
    snapshotAtSend = await queryClient
      // retry:false so a wedged read cannot delay the POST behind three backoffs
      // — it matches useAgentSession's own retry policy.
      .ensureQueryData<AgentSessionResponse>({
        queryKey: sessionKey,
        queryFn: fetchAgentSession,
        retry: false,
      })
      .catch(() => null);
  }
  // RELOAD-WINDOW GUARD (review !62 round 8, finding 4). The composer is usable
  // before the initial GET resolves — gating it on the session read would brick
  // the page for any tenant whose read fails (B5-R5) — so serverAwaitingReply has
  // not computed yet and a fast send can race an in-flight turn on the stateful
  // agent. When we had to AWAIT the read (empty cache: a fresh mount or reload)
  // and it now shows a turn STILL awaiting a reply, reject the send. A CACHED
  // snapshot is NOT this window: the component already derived serverAwaitingReply
  // from it and locked the composer, so a normal send after a user-tail turn is
  // unaffected. A FAILED read (snapshot null) also proceeds — preserving B5-R5.
  if (
    awaitedSessionRead &&
    snapshotAtSend &&
    sessionAwaitsReply(snapshotAtSend.messages, snapshotAtSend.supports_turn_ids === true)
  ) {
    throw new Error(
      'A previous message is still awaiting a reply. Reload the page before sending again.',
    );
  }
  // The identity that will authorize the POST must still be the one that composed
  // this turn (review !62 round 6 Critical 1; round 8 finding 1). The epoch check
  // catches a same-tab sign-out/in; the token check catches a cross-tab swap —
  // localStorage diverging from this tab's anchor means the tab is stale (already
  // or mid-await). Skipped only for a null anchor (headless callers / no session),
  // where the epoch check alone applies.
  if (
    getAuthSessionId() !== authSessionAtSend ||
    (tabTokenAtSend !== null && getAuthToken() !== tabTokenAtSend)
  ) {
    throw new Error(
      'Auth session changed before the message was sent; the turn was not delivered under a different identity.',
    );
  }
  return {
    authSessionAtSend,
    snapshotAtSend,
    priorSameContentUserTurns: countMatchingUserTurns(snapshotAtSend?.messages ?? [], message),
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
 * Drop SETTLED-SUCCESS chat mutations from the cache. With gcTime: Infinity on
 * the mutation (review !62 round 6, Important 3 — so a KEPT uncertain turn is
 * never garbage-collected out from under a later mount), a succeeded turn would
 * otherwise linger until sign-out. Its result is already in the session cache
 * and the transcript, so it is safe to remove; only unresolved turns (pending,
 * or a kept-uncertain error) then persist. Failed turns are removed by the
 * reconciler (AiChat) except the deliberate uncertain exception, and sign-out
 * clears the whole cache — this closes the remaining success case.
 */
export function pruneSettledChatMutations(
  queryClient: QueryClient,
  authSessionId: string | null,
): void {
  const cache = queryClient.getMutationCache();
  for (const mutation of cache.findAll({
    mutationKey: agentChatMutationKey(authSessionId),
    status: 'success',
  })) {
    cache.remove(mutation);
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
    queryFn: fetchAgentSession,
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

/** Mutation variables: the wire request PLUS the send-time bearer token, bound to
 *  THIS turn (review !62 round 7, finding 2). getAuthHeaders re-reads localStorage
 *  at request time, so binding the token here — captured at send, split off before
 *  the body is serialized — is what stops a cross-tab sign-in after the send-time
 *  guard from POSTing this turn under the next identity. authToken never reaches
 *  the wire body. */
export type AgentChatVariables = AgentChatRequest & { authToken: string | null };

/**
 * Sends one chat turn (POST /api/agent/chat). The caller owns session_id
 * threading and transcript state; this hook owns transport and the session
 * cache write.
 */
export function useAgentChatMutation() {
  const queryClient = useQueryClient();
  const { authSessionId } = useAuth();

  return useMutation<AgentChatResponse, Error, AgentChatVariables, AgentChatMutationContext>({
    mutationKey: agentChatMutationKey(authSessionId),
    mutationFn: async ({ authToken, ...params }) => {
      // BOUND-NULL REJECTS, never falls back (review !62 round 8, finding 1). The
      // send binds this tab's own token; a null here means the tab has no valid
      // identity (signed out / torn down by the cross-tab ender). Falling back to
      // getAuthHeaders' localStorage read is exactly the leak — it would POST
      // under whatever origin-wide token a successor left there. Fail instead.
      if (authToken === null) {
        throw new Error('Not signed in; the message was not sent.');
      }
      // authToken is split off here so it is bound to the Authorization header and
      // never serialized into the body (finding 2).
      const response = await apiService.agentChat(params, authToken);
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
    // gcTime: Infinity (review !62 round 6, Important 3): the reconciler KEEPS a
    // failed turn whose delivery is uncertain so its message and pending
    // re-check survive remounts. But useMutationState only SUBSCRIBES to the
    // cache — it attaches no mutation observer — so once the page unmounts the
    // kept mutation is unobserved and TanStack's default 5-minute gcTime evicts
    // it, silently losing the message if GET is still unavailable. Infinity
    // disables that timer; removal is explicit instead — the reconciler removes
    // resolved failures, pruneSettledChatMutations removes succeeded turns, and
    // sign-out's queryClient.clear() drops the rest.
    gcTime: Infinity,
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
    onMutate: (variables) => createAgentChatContext(queryClient, variables.message),
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

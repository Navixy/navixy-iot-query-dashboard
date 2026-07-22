import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
// These messages are thrown, and AiChat renders the thrown message verbatim as a chat
// bubble (`failed.errorMessage`), so they are user-facing. Resolved through the service
// translator because three of the four throw from module-level functions, not the hook.
import { getServiceTranslator } from '@/i18n/serviceTranslator';
import { getAuthSessionId, getAuthToken, getTabSessionToken } from '@/lib/authSession';
import { apiService } from '@/services/api';
import { countMatchingUserTurns, sessionIsAwaitingReply } from '@/components/ai-chat/turnDelivery';
import {
  beginSessionRead,
  recordSessionObservation,
} from '@/components/ai-chat/sessionObservation';
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
 *  read below so both throw on response.error identically.
 *
 *  BINDS THIS TAB'S TOKEN (review !62 round 9, finding 1). The read is as
 *  identity-sensitive as the send: api.ts's getAuthHeaders resolves the
 *  ORIGIN-WIDE localStorage key at dispatch, so a GET issued by a tab whose token
 *  another tab had already replaced would return the SUCCESSOR's transcript and
 *  write it into THIS tab's epoch-scoped cache — before the storage-event ender
 *  had a chance to run (it is asynchronous and cannot be ordered against an
 *  already-queued request). The anchor is read at dispatch and is tab-local, so
 *  it only ever moves on THIS tab's own auth transitions; a null anchor (torn
 *  down) fails closed inside api.ts rather than falling back to shared storage. */
export async function fetchAgentSession(): Promise<AgentSessionResponse> {
  // Draw the ticket BEFORE dispatch (review !62 round 14, Important 1; round 15,
  // Important 1). Downstream nothing can tell a fresh read from a re-publish:
  // structural sharing keeps the OLD object when a refetch is deep-equal, and
  // setQueryData makes an old response look new. The composer lock's release turns
  // on that distinction — and on this read being ordered by when it was ASKED,
  // since a slow GET can return long after its answer stopped being current.
  const ticket = beginSessionRead();
  const response = await apiService.getAgentSession(getTabSessionToken());
  if (response.error) {
    throw new Error(response.error.message);
  }
  recordSessionObservation(ticket, response.data!);
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
 *  it. When the snapshot is not AUTHORITATIVE — absent, or still being validated
 *  by an in-flight refetch (review !62 round 9, finding 3) — we therefore AWAIT
 *  the session read (fetchQuery dedups onto the in-flight GET, so joining a
 *  mount refetch costs no extra round trip) to capture the true pre-send
 *  transcript before the POST fires. A failed read leaves the baseline at
 *  whatever was cached — 0 when nothing was — the acknowledged residual a stable
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
  const sessionState = queryClient.getQueryState<AgentSessionResponse>(sessionKey);
  const cachedSnapshot = sessionState?.data ?? null;
  let snapshotAtSend = cachedSnapshot;
  // WHEN IS THE CACHE AUTHORITY? (review !62 round 9, finding 3.) Round 8 asked
  // only "is it empty", which treated a snapshot left by a PREVIOUS mount as
  // server truth. It is not: navigate away with an idle transcript, let a turn be
  // sent from elsewhere, come back — React Query serves that stale idle cache
  // instantly and refetches in parallel, so serverAwaitingReply is false, the
  // composer is open, and a fast Send starts a SECOND turn on the stateful agent
  // without ever waiting for the refetch. A snapshot is authoritative only when
  // no fetch is in flight against it; while one is, this send joins it.
  const needsAuthoritativeRead =
    authSessionAtSend !== null &&
    (cachedSnapshot === null || sessionState?.fetchStatus === 'fetching');
  // Did this send actually OBTAIN server truth? Only then may it judge whether a
  // turn is still awaiting a reply — a failed read leaves us with the same data
  // the component already saw, which is no basis for refusing the send.
  let hasAuthoritativeSnapshot = false;
  if (needsAuthoritativeRead) {
    const fresh = await queryClient
      // fetchQuery, not ensureQueryData: ensureQueryData returns cached data
      // WITHOUT waiting, which is precisely the defect above. fetchQuery dedups
      // onto an in-flight fetch for the same key, so joining the mount refetch
      // costs no extra round trip; with an empty cache it behaves as before.
      // retry:false so a wedged read cannot delay the POST behind three backoffs
      // — it matches useAgentSession's own retry policy.
      .fetchQuery<AgentSessionResponse>({
        queryKey: sessionKey,
        queryFn: fetchAgentSession,
        retry: false,
      })
      // A read that cannot validate must not brick the send (B5-R5).
      .catch(() => null);
    if (fresh !== null) {
      snapshotAtSend = fresh;
      hasAuthoritativeSnapshot = true;
    } else if (cachedSnapshot !== null) {
      // A FAILED validation of a STALE cache is not a reason to proceed (review
      // !62 round 9 shipped it as one; round 10, Important 3). We only get here
      // because a refetch was in flight against a snapshot left by a previous
      // mount — the exact situation in which another tab may have started a turn
      // — and the probe that would have told us just failed. Sending anyway puts
      // the whole race back on the error path.
      //
      // This is NOT the B5-R5 case, which is about a tenant whose session read
      // NEVER succeeds: such a tenant has no cache to be stale, takes the
      // empty-cache branch below, and still sends. Only a tab that once had a
      // transcript and cannot currently confirm it is asked to wait.
      throw new Error(
        getServiceTranslator()('ai_chat.send_error.unconfirmed_state.paragraph.failure'),
      );
    }
    // With an EMPTY cache a failed read leaves snapshotAtSend null and the send
    // proceeds on a 0 baseline — the acknowledged residual, and what keeps the
    // page usable for a tenant whose history read is broken (B5-R5).
  }
  // RELOAD-WINDOW GUARD (review !62 round 8, finding 4; widened round 9, finding
  // 3). The composer is usable before a session read resolves — gating it on the
  // read would brick the page for any tenant whose read fails (B5-R5) — so
  // serverAwaitingReply has not computed yet and a fast send can race an in-flight
  // turn on the stateful agent. Whenever this send had to AWAIT an authoritative
  // read (an empty cache on a fresh mount or reload, OR a remount whose refetch
  // had not yet validated a leftover snapshot) and that read shows a turn STILL
  // awaiting a reply, reject. A SETTLED cached snapshot is not this window: the
  // component already derived serverAwaitingReply from it and locked the composer.
  // A read that failed against an EMPTY cache proceeds on a null snapshot (B5-R5);
  // one that failed against a STALE cache never reaches here — it rejected above.
  if (
    hasAuthoritativeSnapshot &&
    snapshotAtSend &&
    sessionIsAwaitingReply(snapshotAtSend)
  ) {
    throw new Error(
      getServiceTranslator()('ai_chat.send_error.awaiting_reply.paragraph.failure'),
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
      getServiceTranslator()('ai_chat.send_error.session_changed.paragraph.failure'),
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
        throw new Error(getServiceTranslator()('ai_chat.send_error.signed_out.paragraph.failure'));
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

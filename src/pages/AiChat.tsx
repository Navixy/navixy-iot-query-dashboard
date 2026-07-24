import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutationState, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import {
  agentChatMutationKey,
  agentSessionQueryKey,
  pruneSettledChatMutations,
  useAgentChatMutation,
  useAgentSession,
  type AgentChatMutationContext,
} from '@/hooks/use-agent-chat';
import { getAuthSessionId, getTabSessionToken } from '@/lib/authSession';
import { apiService } from '@/services/api';
import { ChatComposer } from '@/components/ai-chat/ChatComposer';
import { ChatTranscript } from '@/components/ai-chat/ChatTranscript';
import { EmptyState } from '@/components/ai-chat/EmptyState';
import { trimHistoryOverlap } from '@/components/ai-chat/historyOverlap';
import {
  appendUncertainNotice,
  applyReceiptToDelivery,
  classifyTurnDelivery,
  locksComposerAwaitingReply,
  reconcileOutcome,
  sessionAwaitsReply,
  type TurnDelivery,
} from '@/components/ai-chat/turnDelivery';
import type {
  AgentChatRequest,
  AgentSessionResponse,
  AgentTurn,
  ChatBubble,
} from '@/types/agent';

/**
 * One renderer, two sources: rehydrated history turns and live turns both
 * become ChatBubbles. `type` is persisted on assistant turns so a reloaded
 * transcript renders exactly as the live session did — a past 'error' must not
 * come back as ordinary assistant prose. An absent `type` (user turns, legacy
 * rows) is treated as 'question'.
 */
function turnToBubble(turn: AgentTurn, index: number): ChatBubble {
  if (turn.role === 'user') {
    return { id: `history-${index}`, role: 'user', text: turn.content };
  }
  return {
    id: `history-${index}`,
    role: 'assistant',
    text: turn.content,
    result: turn.type === 'result' ? turn.result : undefined,
    isError: turn.type === 'error' || undefined,
  };
}

const AiChat = () => {
  const { user, loading, authSessionId } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  const sessionQuery = useAgentSession();
  const chat = useAgentChatMutation();
  const queryClient = useQueryClient();

  // Pending state ACROSS remounts (review !62, major 1). chat.isPending is
  // per-observer: a page that unmounts mid-turn and remounts sees false while
  // the 7-36 s turn is still in flight — composer enabled, no indicator, and a
  // re-send double-feeds the stateful Bedrock session. useMutationState reads
  // the shared mutation cache instead, so the returning mount keeps the
  // composer locked and the typing indicator up until the turn settles. The
  // key is epoch-scoped (review !62 round 2): another sign-in's in-flight turn
  // must not lock THIS user's composer.
  const chatMutationKey = agentChatMutationKey(authSessionId);
  const pendingChatTurns = useMutationState({
    filters: { mutationKey: chatMutationKey, status: 'pending' },
    select: (mutation) => mutation.state.status,
  });

  // FAILED turns are read from the MUTATION CACHE, never from mutate-level
  // onError (review !62 round 2, Important 4): mutate-level callbacks are
  // observer-bound — navigate away mid-turn and they simply never run, so the
  // failure used to vanish on the returning mount. The cache entry outlives the
  // page (until its gcTime, ~5 min), so whichever mount is live when the turn
  // settles reconciles it against the server.
  const failedChatTurns = useMutationState({
    filters: { mutationKey: chatMutationKey, status: 'error' },
    select: (mutation) => ({
      mutationId: mutation.mutationId,
      message: (mutation.state.variables as AgentChatRequest | undefined)?.message ?? '',
      // The client-minted idempotency id this turn was sent with (review !62
      // round 6): the reconciler matches the server transcript by it, so a lost
      // response is classified deterministically rather than by content.
      clientTurnId:
        (mutation.state.variables as AgentChatRequest | undefined)?.client_turn_id ?? null,
      errorMessage:
        mutation.state.error instanceof Error ? mutation.state.error.message : '',
      // Send-time occurrence baseline (review !62 round 4, Important 2): the
      // FALLBACK for a tenant whose server does not round-trip ids — how many
      // identical user turns the client already knew about when this turn was
      // sent, so content reconciliation counts only a NEW occurrence as delivery.
      priorSameContentUserTurns:
        (mutation.state.context as AgentChatMutationContext | undefined)
          ?.priorSameContentUserTurns ?? 0,
    }),
  });
  const handledFailedTurnsRef = useRef<Set<number>>(new Set());
  // Reconciling a failed turn against the server is ASYNC (review !62 round 4,
  // Important 1c): after the mutation flips to 'error' it is no longer 'pending',
  // so without this the composer would UNLOCK mid-reconciliation and let a
  // second, possibly duplicate, turn go out. `reconcilingCount` covers the async
  // window; `unhandledFailedTurns` covers the render between the error landing
  // and the effect starting — together the composer stays locked from error to
  // resolution.
  const [reconcilingCount, setReconcilingCount] = useState(0);
  const unhandledFailedTurns = failedChatTurns.filter(
    (f) => !handledFailedTurnsRef.current.has(f.mutationId),
  ).length;

  // A delivered-but-unanswered turn ('received') or one reconciliation could not
  // confirm ('uncertain') leaves the composer LOCKED (review !62 round 6,
  // Important 4). Mount-local — it covers THIS mount, chiefly the uncertain case
  // whose turn the server may not even show. See locksComposerAwaitingReply.
  const [awaitingServerReply, setAwaitingServerReply] = useState(false);

  // SERVER-DERIVED lock that SURVIVES a remount (review !62 round 7, finding 4):
  // the round-6 mount-local flag reset on navigate-away, and a 'received' turn's
  // mutation was removed, so the composer re-enabled while the first stateful
  // invocation was still running. The route appends the assistant AFTER the agent
  // call, so a transcript whose newest turn is a USER turn means a turn is still
  // in flight — derive the lock from that persisted state instead. A fresh mount
  // re-reads it from GET /session, so the lock cannot be lost by navigating away.
  const serverAwaitingReply = sessionAwaitsReply(sessionQuery.data?.messages ?? []);

  const isChatPending =
    pendingChatTurns.length > 0 ||
    chat.isPending ||
    reconcilingCount > 0 ||
    unhandledFailedTurns > 0 ||
    awaitingServerReply ||
    serverAwaitingReply;

  // While the server shows an unanswered turn, POLL until its reply lands (finding
  // 4: "retain/poll the received turn until its matching assistant row exists").
  // Bounded past the 190 s transport ceiling; stops the moment the reply arrives
  // (serverAwaitingReply flips false) or the page unmounts.
  const refetchSession = sessionQuery.refetch;
  useEffect(() => {
    if (!serverAwaitingReply) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > 48) {
        clearInterval(timer);
        return;
      }
      void refetchSession();
    }, 5000);
    return () => clearInterval(timer);
  }, [serverAwaitingReply, refetchSession]);

  // D13: the SERVER is authoritative. Seeded from the session query, then
  // OVERWRITTEN from every single response — including error responses, which
  // still carry a session_id. A ref, not state: nothing renders from it, and
  // making it state would re-render the transcript on every turn for no reason.
  const sessionIdRef = useRef<string | null>(null);

  // Turns produced in THIS mount. Rehydrated history is NOT copied in here; the
  // two sources are concatenated at render time so a refetch cannot duplicate a
  // turn.
  const [liveBubbles, setLiveBubbles] = useState<ChatBubble[]>([]);

  // The history THIS mount renders. Tracks the session query WHILE no live
  // bubble exists — so a remount mid-turn re-materializes the in-flight user
  // turn from the mount refetch, and the reply lands via the mutation's
  // hook-level cache write (review !62, major 1). Once a live bubble exists it
  // accepts at most ONE more payload — the FIRST (see below) — and then
  // FREEZES: from then on the cache updates are the mutation's own writes,
  // already represented by liveBubbles, and rendering the query data too would
  // show every turn twice.
  const [historyBubbles, setHistoryBubbles] = useState<ChatBubble[] | null>(null);
  const historyAcceptedRef = useRef(false);

  useEffect(() => {
    const data = sessionQuery.data;
    if (!data) return;
    if (sessionIdRef.current === null) {
      sessionIdRef.current = data.session_id;
    }
    if (liveBubbles.length === 0) {
      historyAcceptedRef.current = true;
      setHistoryBubbles(data.messages.map(turnToBubble));
    } else if (!historyAcceptedRef.current) {
      // FIRST history to arrive on a mount that has already sent (review !62
      // round 2, Important 5): the composer is deliberately usable while the
      // initial GET is in flight, and refusing its late response outright hid
      // the user's entire previous transcript until the next remount. Accept
      // it once, minus the seam — the response may already contain the turns
      // this mount rendered live (the user turn persists at POST receipt; a
      // slow GET can even carry the finished exchange), and rendering both
      // copies would duplicate them.
      historyAcceptedRef.current = true;
      setHistoryBubbles(trimHistoryOverlap(data.messages, liveBubbles).map(turnToBubble));
    }
  }, [sessionQuery.data, liveBubbles]);

  const [composerValue, setComposerValue] = useState('');
  const liveIdRef = useRef(0);
  const nextLiveId = () => `live-${liveIdRef.current++}`;

  // The handling below is ASYNC (it polls the server). If this mount dies
  // before reconciliation resolves, the mutation must stay in the cache so the
  // next mount re-runs it — this flag is how the continuation knows.
  const failureHandlingAliveRef = useRef(true);
  useEffect(() => {
    failureHandlingAliveRef.current = true;
    return () => {
      failureHandlingAliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (failedChatTurns.length === 0) return;
    const run = async () => {
      for (const failed of failedChatTurns) {
        // The handled-set plus the removal below make this idempotent across
        // StrictMode double-effects and re-renders.
        if (handledFailedTurnsRef.current.has(failed.mutationId)) continue;
        handledFailedTurnsRef.current.add(failed.mutationId);
        // Holds the composer locked for the whole reconciliation, not just
        // while the mutation was 'pending' (review !62 round 4, Important 1c).
        setReconcilingCount((c) => c + 1);
        try {
          // TRANSPORT UNCERTAINTY (review !62 rounds 3–4): a transport error is
          // not a verdict. The server persists the user turn at receipt and
          // keeps processing after a client disconnect, so the turn may have
          // fully succeeded with only the response lost — restoring the draft
          // then invites re-feeding the stateful agent a message it already
          // consumed (R20/D19). A single GET is not proof either: the route
          // does loadHistory BEFORE it appends the user turn (agent.ts), so a
          // GET can overtake an in-flight POST and miss it. BOUNDED POLL: the
          // user turn lands at receipt — before the multi-second agent call —
          // so a couple of short retries reliably separate "arrived, still
          // working / response lost" from "never arrived", closing that race
          // (round 4, Important 1a/1b).
          let authoritative: AgentSessionResponse | null = null;
          let delivery: TurnDelivery = 'lost';
          // Whether the MOST RECENT poll attempt returned data. A 'lost' verdict
          // is only trustworthy if the last probe succeeded and still showed the
          // turn absent — an early 'lost' that later FAILED probes never
          // re-confirmed is the overtake race, i.e. uncertain (round 5, Important 3).
          let lastGetSucceeded = false;
          // Whether the server round-trips ids (finding 5a), taken from the last
          // successful GET rather than inferred from a visible row.
          let supportsTurnIds = false;
          const backoffMs = [0, 700, 1400];
          for (let attempt = 0; attempt < backoffMs.length; attempt++) {
            if (backoffMs[attempt] > 0) {
              await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
            }
            if (!failureHandlingAliveRef.current) {
              handledFailedTurnsRef.current.delete(failed.mutationId);
              return;
            }
            const response = await apiService.getAgentSession().catch(() => null);
            if (!failureHandlingAliveRef.current) {
              handledFailedTurnsRef.current.delete(failed.mutationId);
              return;
            }
            lastGetSucceeded = response?.data != null;
            if (!response?.data) continue; // this GET failed; keep the last good one
            authoritative = response.data;
            supportsTurnIds = response.data.supports_turn_ids === true;
            delivery = classifyTurnDelivery(
              response.data.messages,
              failed.message,
              failed.clientTurnId,
              supportsTurnIds,
              failed.priorSameContentUserTurns,
            );
            if (delivery !== 'lost') break; // delivered — stop polling
            // 'lost' on a SUCCESSFUL GET may still be the overtake race; poll again.
          }

          // DURABLE RECEIPT RECONFIRMATION (review !62 round 7, finding 5b): on the
          // id path a 'lost' only means "not in the capped transcript" — the turn's
          // rows can be evicted by 100 newer ones while its mutation persists
          // (gcTime: Infinity). Confirm against the receipt, which lives outside
          // that window, before trusting 'lost'. supported:false (older schema)
          // leaves the transcript verdict untouched.
          if (delivery === 'lost' && lastGetSucceeded && supportsTurnIds && failed.clientTurnId) {
            const receipt = await apiService.getAgentTurnStatus(failed.clientTurnId).catch(() => null);
            if (!failureHandlingAliveRef.current) {
              handledFailedTurnsRef.current.delete(failed.mutationId);
              return;
            }
            delivery = applyReceiptToDelivery(delivery, receipt?.data ?? null);
          }

          const outcome = reconcileOutcome(authoritative !== null, delivery, lastGetSucceeded);
          // Lock the composer if this turn may still be running on the agent
          // ('received') or its fate is unknown ('uncertain') — a second POST now
          // would race it (review !62 round 6, Important 4). Sticky once set: only
          // a reload (fresh mount) clears it, having re-read the session.
          if (locksComposerAwaitingReply(outcome, delivery)) {
            setAwaitingServerReply(true);
          }
          if (authoritative && outcome === 'delivered') {
            // The server HAS the turn. Render server truth wholesale: the
            // authoritative transcript replaces both sources (older client-only
            // error bubbles vanish with it). NO draft restore — the message is
            // on the server, and re-sending would double-feed the agent.
            sessionIdRef.current = authoritative.session_id;
            if (authSessionId !== null && getAuthSessionId() === authSessionId) {
              queryClient.setQueryData<AgentSessionResponse>(
                agentSessionQueryKey(authSessionId),
                authoritative,
              );
            }
            historyAcceptedRef.current = true;
            setHistoryBubbles(authoritative.messages.map(turnToBubble));
            setLiveBubbles(
              delivery === 'received'
                ? [
                    // Delivered but unanswered so far — the agent may still be
                    // working server-side. Say so without inviting a re-send.
                    {
                      id: nextLiveId(),
                      role: 'assistant',
                      text: 'The connection was lost while the assistant was replying. Your message was delivered — the reply may appear the next time you open this page.',
                      isError: true,
                    },
                  ]
                : [],
            );
          } else if (authoritative && outcome === 'confirmed-lost') {
            // The MOST RECENT successful GET agreed the turn is ABSENT, after the
            // poll closed the overtake window: it never reached the server. (An
            // early absence that later failed probes could not re-confirm is
            // NOT this branch — it falls through to uncertain, round 5 Imp. 3.)
            // Now it is safe to give the message back (the send cleared the
            // composer optimistically; a 429/network drop must not destroy a
            // carefully-typed request). The guard keeps anything typed since.
            setComposerValue((current) => (current === '' ? failed.message : current));
            setLiveBubbles((prev) => [
              ...prev,
              {
                id: nextLiveId(),
                role: 'assistant',
                text: failed.errorMessage || 'The request failed. Please try again.',
                isError: true,
              },
            ]);
          } else {
            // UNCERTAIN (review !62 round 4 Imp. 1a; round 5 Imp. 3): no GET
            // ever succeeded, OR an early 'lost' that later failed probes never
            // re-confirmed. We CANNOT tell "never sent" from "sent, still
            // processing, response lost". Do NOT restore the draft: an automatic
            // retry could double-feed a turn the server may have taken.
            //
            // The message must still SURVIVE (round 5, Critical 1). liveBubbles
            // is mount-local, so on a REMOUNT the optimistic user bubble died
            // with the previous mount and the text would be visible NOWHERE.
            // appendUncertainNotice re-materializes it from the failed mutation
            // (deduped against the optimistic bubble on the original mount); the
            // mutation is KEPT in the cache below so both the text and a later
            // authoritative re-check survive further remounts. Shown as a
            // transcript bubble, not a composer draft — preserved without
            // becoming a one-click resend.
            setLiveBubbles((prev) => appendUncertainNotice(prev, failed.message, nextLiveId));
          }

          // Handled — REMOVE it so a later mount does not surface it again. The
          // UNCERTAIN outcome is the deliberate exception: it KEEPS the mutation
          // so the message text and the pending re-check survive further
          // remounts (round 5, Critical 1). A later mount whose network has
          // recovered then reconciles it authoritatively; until then each mount
          // re-materializes the message from it. gcTime evicts it if it never
          // resolves, so it cannot accumulate forever.
          if (outcome !== 'uncertain') {
            const mutationCache = queryClient.getMutationCache();
            const mutation = mutationCache
              .getAll()
              .find((m) => m.mutationId === failed.mutationId);
            if (mutation) mutationCache.remove(mutation);
          }
        } finally {
          setReconcilingCount((c) => c - 1);
        }
      }
    };
    void run();
  }, [failedChatTurns, queryClient, authSessionId]);

  // With gcTime: Infinity keeping unresolved turns alive across remounts (review
  // !62 round 6, Important 3), SUCCEEDED turns would otherwise pile up in the
  // mutation cache until sign-out. Their result is already in the session cache
  // and the transcript, so prune them once settled — only unresolved turns
  // (pending, or a kept-uncertain error) then persist.
  const settledSuccessCount = useMutationState({
    filters: { mutationKey: chatMutationKey, status: 'success' },
    select: (mutation) => mutation.mutationId,
  }).length;
  useEffect(() => {
    if (settledSuccessCount > 0) {
      pruneSettledChatMutations(queryClient, authSessionId);
    }
  }, [settledSuccessCount, queryClient, authSessionId]);

  // MR 6 reads this to decide whether to render the Apply button. Computed here
  // so there is exactly one definition of the rule (D15): Apply is admin/editor
  // only — POST /reports is requireAdminOrEditor (app.ts:846) — and a viewer
  // must see an explanation, never a raw 403.
  const canApply = user?.role === 'admin' || user?.role === 'editor';

  const send = () => {
    const message = composerValue.trim();
    if (message === '' || isChatPending) return;
    // Mint a per-send idempotency id (review !62 round 6): the server persists it
    // on the user turn and returns it in GET /session, so a lost response is
    // reconciled by id (classifyTurnDelivery), not by fragile content matching.
    const clientTurnId = crypto.randomUUID();
    setComposerValue('');
    setLiveBubbles((prev) => [...prev, { id: nextLiveId(), role: 'user', text: message }]);
    chat.mutate(
      // Bind THIS TAB's own token (round 8, finding 1), not a fresh localStorage
      // read: a tab already stale from a cross-tab sign-in would otherwise read
      // and POST under the successor's token. onMutate rejects if this anchor has
      // diverged from localStorage, and mutationFn rejects a null anchor rather
      // than falling back to shared storage. authToken never reaches the body.
      { session_id: sessionIdRef.current, message, client_turn_id: clientTurnId, authToken: getTabSessionToken() },
      {
        // This mutate-level callback updates THIS mount's transcript and is
        // skipped if the page unmounts mid-turn — liveBubbles die with the
        // mount anyway. The hook-level onSuccess still runs and preserves the
        // turns in the query cache for the next mount. There is deliberately
        // NO mutate-level onError: failures are surfaced by the failed-turns
        // effect above from the mutation cache, so a remount cannot lose the
        // error or the draft (review !62 round 2, Important 4). A transport
        // failure also carries no session_id to adopt — the ref keeps its
        // last known value.
        onSuccess: (data) => {
          sessionIdRef.current = data.session_id;
          setLiveBubbles((prev) => [
            ...prev,
            {
              id: nextLiveId(),
              role: 'assistant',
              text: data.message,
              result: data.type === 'result' ? data.result : undefined,
              // One renderer, two failure paths (1 of 2): the server's in-band
              // type:'error' gets the same destructive bubble as a transport
              // failure. No toast — the error belongs in the transcript where
              // the user is looking.
              isError: data.type === 'error' || undefined,
            },
          ]);
        },
      },
    );
  };

  // Copied from src/pages/App.tsx — there is no ProtectedRoute component;
  // every page hand-rolls this redirect-plus-spinner. The spinner keeps its
  // min-h-screen deliberately: it returns BEFORE <AppLayout> mounts, so it is
  // never inside the h-svh shell (FR-11509 unaffected).
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    );
  }

  const bubbles = historyBubbles ? [...historyBubbles, ...liveBubbles] : liveBubbles;

  return (
    <AppLayout contentClassName="h-full flex flex-col min-h-0 px-6 max-w-7xl mx-auto w-full">
      <div className="min-h-0 flex-1">
        {bubbles.length > 0 ? (
          <ChatTranscript bubbles={bubbles} isPending={isChatPending} canApply={canApply} />
        ) : sessionQuery.isLoading ? (
          <div className="space-y-4 py-6" aria-hidden="true">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="ml-auto h-10 w-1/2" />
            <Skeleton className="h-24 w-2/3" />
          </div>
        ) : (
          <EmptyState onPick={setComposerValue} historyFailed={sessionQuery.isError} />
        )}
      </div>
      <div className="shrink-0 pb-6 pt-2">
        {/* The composer is NEVER disabled by sessionQuery.isError or isLoading —
            only by an in-flight chat turn. Gating it on the session read breaks
            the page for every tenant whose session read fails (B5-R5, M13). */}
        <ChatComposer
          value={composerValue}
          onChange={setComposerValue}
          onSend={send}
          disabled={isChatPending}
        />
        {sessionQuery.data?.persisted === false && (
          // Disables nothing, and says nothing about the agent's memory (D19)
          // — Bedrock holds its own conversation state server-side either way.
          // Blames the SERVICE, not the browser (review !62 round 2, minor):
          // unpersisted history lives in backend process memory, which a page
          // reload does survive — a restart, a replica switch or the 2 h TTL
          // is what loses it.
          <p className="mt-2 text-xs text-muted-foreground">
            Chat history is not being saved for this workspace and may be lost
            when the service restarts.
          </p>
        )}
      </div>
    </AppLayout>
  );
};

export default AiChat;

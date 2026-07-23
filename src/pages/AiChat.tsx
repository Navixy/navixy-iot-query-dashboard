import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutationState, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import {
  agentChatMutationKey,
  agentSessionQueryKey,
  useAgentChatMutation,
  useAgentSession,
} from '@/hooks/use-agent-chat';
import { getAuthSessionId } from '@/lib/authSession';
import { apiService } from '@/services/api';
import { ChatComposer } from '@/components/ai-chat/ChatComposer';
import { ChatTranscript } from '@/components/ai-chat/ChatTranscript';
import { EmptyState } from '@/components/ai-chat/EmptyState';
import { trimHistoryOverlap } from '@/components/ai-chat/historyOverlap';
import { classifyTurnDelivery } from '@/components/ai-chat/turnDelivery';
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
  const isChatPending = pendingChatTurns.length > 0 || chat.isPending;

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

  // FAILED turns are read from the MUTATION CACHE, never from mutate-level
  // onError (review !62 round 2, Important 4): mutate-level callbacks are
  // observer-bound — navigate away mid-turn and they simply never run, so the
  // failure used to vanish on the returning mount: the typing indicator
  // stopped, with no error bubble and the draft gone. The cache entry outlives
  // the page (until its gcTime, ~5 min), so whichever mount is live when the
  // turn settles renders the failure and returns the draft.
  const failedChatTurns = useMutationState({
    filters: { mutationKey: chatMutationKey, status: 'error' },
    select: (mutation) => ({
      mutationId: mutation.mutationId,
      message: (mutation.state.variables as AgentChatRequest | undefined)?.message ?? '',
      errorMessage:
        mutation.state.error instanceof Error ? mutation.state.error.message : '',
    }),
  });
  const handledFailedTurnsRef = useRef<Set<number>>(new Set());
  // The handling below is ASYNC (it consults the server first). If this mount
  // dies before a classification resolves, the mutation must stay in the cache
  // so the next mount re-runs it — this flag is how the continuation knows.
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

        // TRANSPORT UNCERTAINTY (review !62 round 3, Important 2): a transport
        // error does NOT mean the turn failed. The server persists the user
        // turn at receipt and keeps processing after a client disconnect, so
        // the turn may have fully succeeded with only the response lost —
        // and restoring the draft then INVITES re-feeding the stateful agent
        // session with a message it already consumed (R20/D19). Ask the
        // server what actually happened before surfacing anything.
        const response = await apiService.getAgentSession().catch(() => null);
        const authoritative = response?.data ?? null;
        // If the GET itself failed, the network is down generally — the POST
        // almost certainly never processed, and 'lost' (retry-friendly) is
        // the right verdict.
        const delivery = authoritative
          ? classifyTurnDelivery(authoritative.messages, failed.message)
          : 'lost';

        if (!failureHandlingAliveRef.current) {
          // Un-mark so a still-alive later effect run (StrictMode's simulated
          // remount shares these refs) — or the next real mount — retries.
          handledFailedTurnsRef.current.delete(failed.mutationId);
          return;
        }

        if (authoritative && delivery !== 'lost') {
          // The server HAS the turn. Render server truth wholesale: the
          // authoritative transcript replaces both sources (older transport
          // error bubbles vanish with it — they were client-only and are
          // superseded by the server's account). NO draft restore in either
          // branch: the message is on the server.
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
        } else {
          // Genuinely lost before the server saw it. Give the user their
          // message back: the send cleared the composer optimistically, and a
          // 429/network drop must not destroy a carefully-typed request
          // (review !62). The guard keeps anything they typed since.
          const draft = failed.message;
          setComposerValue((current) => (current === '' ? draft : current));
          // One renderer, two failure paths (2 of 2): transport failures
          // render exactly like the in-band type:'error' handled in send's
          // onSuccess. No toast — the error belongs in the transcript.
          setLiveBubbles((prev) => [
            ...prev,
            {
              id: nextLiveId(),
              role: 'assistant',
              text: failed.errorMessage || 'The request failed. Please try again.',
              isError: true,
            },
          ]);
        }

        // Handled — REMOVE it so a later mount does not surface it again.
        const mutationCache = queryClient.getMutationCache();
        const mutation = mutationCache
          .getAll()
          .find((m) => m.mutationId === failed.mutationId);
        if (mutation) mutationCache.remove(mutation);
      }
    };
    void run();
  }, [failedChatTurns, queryClient, authSessionId]);

  // MR 6 reads this to decide whether to render the Apply button. Computed here
  // so there is exactly one definition of the rule (D15): Apply is admin/editor
  // only — POST /reports is requireAdminOrEditor (app.ts:846) — and a viewer
  // must see an explanation, never a raw 403.
  const canApply = user?.role === 'admin' || user?.role === 'editor';

  const send = () => {
    const message = composerValue.trim();
    if (message === '' || isChatPending) return;
    setComposerValue('');
    setLiveBubbles((prev) => [...prev, { id: nextLiveId(), role: 'user', text: message }]);
    chat.mutate(
      { session_id: sessionIdRef.current, message },
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

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutationState } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import {
  agentChatMutationKey,
  useAgentChatMutation,
  useAgentSession,
} from '@/hooks/use-agent-chat';
import { ChatComposer } from '@/components/ai-chat/ChatComposer';
import { ChatTranscript } from '@/components/ai-chat/ChatTranscript';
import { EmptyState } from '@/components/ai-chat/EmptyState';
import type { AgentTurn, ChatBubble } from '@/types/agent';

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
  // hook-level cache write (review !62, major 1). It FREEZES the moment a
  // bubble is produced live: from then on the cache updates for this turn are
  // already represented by liveBubbles, and rendering the live query data too
  // would show every turn twice. If a turn completes before the session read
  // returns, freezing without the history is the duplication-safe side of that
  // race (the next mount reconciles from the server).
  const [historyBubbles, setHistoryBubbles] = useState<ChatBubble[] | null>(null);

  useEffect(() => {
    const data = sessionQuery.data;
    if (!data) return;
    if (sessionIdRef.current === null) {
      sessionIdRef.current = data.session_id;
    }
    if (liveBubbles.length === 0) {
      setHistoryBubbles(data.messages.map(turnToBubble));
    }
  }, [sessionQuery.data, liveBubbles.length]);

  const [composerValue, setComposerValue] = useState('');
  const liveIdRef = useRef(0);

  // MR 6 reads this to decide whether to render the Apply button. Computed here
  // so there is exactly one definition of the rule (D15): Apply is admin/editor
  // only — POST /reports is requireAdminOrEditor (app.ts:846) — and a viewer
  // must see an explanation, never a raw 403.
  const canApply = user?.role === 'admin' || user?.role === 'editor';

  const send = () => {
    const message = composerValue.trim();
    if (message === '' || isChatPending) return;
    const nextLiveId = () => `live-${liveIdRef.current++}`;
    setComposerValue('');
    setLiveBubbles((prev) => [...prev, { id: nextLiveId(), role: 'user', text: message }]);
    chat.mutate(
      { session_id: sessionIdRef.current, message },
      {
        // These mutate-level callbacks update THIS mount's transcript and are
        // skipped if the page unmounts mid-turn — liveBubbles die with the
        // mount anyway. The hook-level onSuccess still runs and preserves the
        // turns in the query cache for the next mount.
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
              // failure below. No toast — the error belongs in the transcript
              // where the user is looking.
              isError: data.type === 'error' || undefined,
            },
          ]);
        },
        onError: (error) => {
          // Give the user their message back: the send cleared the composer
          // optimistically, and a 429/timeout/network drop must not destroy a
          // possibly long, carefully-typed request (review !62). The composer
          // was disabled for the whole flight, so it can only be empty here —
          // the guard is belt and braces against a future edit.
          setComposerValue((current) => (current === '' ? message : current));
          // No session_id to adopt — a transport failure carries no response
          // body. The ref keeps its last known value.
          setLiveBubbles((prev) => [
            ...prev,
            {
              id: nextLiveId(),
              role: 'assistant',
              text: error.message || 'The request failed. Please try again.',
              // One renderer, two failure paths (2 of 2): transport failures
              // render exactly like the in-band type:'error' above.
              isError: true,
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
          <p className="mt-2 text-xs text-muted-foreground">
            Chat history is not persisted for this workspace and will not
            survive a reload.
          </p>
        )}
      </div>
    </AppLayout>
  );
};

export default AiChat;

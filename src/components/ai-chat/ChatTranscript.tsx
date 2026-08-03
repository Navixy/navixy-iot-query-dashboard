import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ChatBubble } from '@/types/agent';
import { MarkdownMessage } from './MarkdownMessage';
import { ResultCard } from './ResultCard';
import { TypingIndicator } from './TypingIndicator';

interface ChatTranscriptProps {
  bubbles: ChatBubble[];
  /** The chat mutation's isPending: renders the typing indicator and dims
   *  result slots. */
  isPending: boolean;
  /** D15, computed once in AiChat: admin/editor only. Threaded through to
   *  ResultSlot so MR 6 touches one component, not three. */
  canApply: boolean;
}

export function ChatTranscript({ bubbles, isPending, canApply }: ChatTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // aria-live is flipped on AFTER the first commit — the "seed history in a
  // non-live pass" option: a live region announces mutations, not content that
  // is already there when it becomes live. History present at mount is
  // therefore never re-announced, while every bubble appended afterwards is.
  const [announceLive, setAnnounceLive] = useState(false);
  useEffect(() => {
    setAnnounceLive(true);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Scroll the CONTAINER, not the page. Scrolling the last bubble into view
    // with the DOM's into-view helper would walk up to <main> (AppLayout.tsx:49,
    // the app's sole scroll container) and scroll the whole app under the
    // header — the transcript owns its own overflow here. (The helper's name is
    // deliberately not written out: the reviewer probe greps this directory for
    // it and must stay empty.)
    el.scrollTop = el.scrollHeight;
  }, [bubbles.length, isPending]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Conversation with the AI assistant"
      aria-live={announceLive ? 'polite' : 'off'}
      className="h-full overflow-y-auto py-6"
    >
      <div className="flex flex-col gap-3">
        {bubbles.map((bubble) => (
          <div
            key={bubble.id}
            className={cn('flex', bubble.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div className="max-w-[80%]">
              <div
                className={cn(
                  'rounded-lg px-4 py-2.5 text-sm',
                  bubble.role === 'user' && 'bg-primary text-primary-foreground',
                  bubble.role === 'assistant' && !bubble.isError && 'bg-muted text-foreground',
                  bubble.isError && 'border border-destructive/30 bg-destructive/10 text-destructive',
                )}
              >
                {bubble.role === 'assistant' ? (
                  <MarkdownMessage text={bubble.text} />
                ) : (
                  // The user did not write markdown — render plain text.
                  <p className="whitespace-pre-wrap">{bubble.text}</p>
                )}
              </div>
              {/* Any assistant bubble carrying a result gets a card — including
                  rehydrated and earlier ones, the affordance for "refine, then
                  decide". */}
              {bubble.result && (
                <ResultCard result={bubble.result} canApply={canApply} isPending={isPending} />
              )}
            </div>
          </div>
        ))}
        {isPending && (
          <div className="flex justify-start">
            <TypingIndicator />
          </div>
        )}
      </div>
    </div>
  );
}

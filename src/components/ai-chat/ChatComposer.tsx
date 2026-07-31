import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * Mirrors MAX_MESSAGE_LENGTH exported from backend/src/routes/agent.ts — the
 * server still enforces its copy with a 400; this one only saves the user the
 * round-trip. Grep for MAX_MESSAGE_LENGTH to find both.
 */
const MAX_MESSAGE_LENGTH = 4000;

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Reads `value` from the parent; whitespace-only input is a no-op. */
  onSend: () => void;
  /** ONLY the chat mutation's isPending — never the session query's state.
   *  A failed or slow history read must leave the composer usable (B5-R5). */
  disabled: boolean;
}

export function ChatComposer({ value, onChange, onSend, disabled }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-focus when a turn completes (disabled flips back to false) so the user
  // does not have to click into the textarea after every reply. Also focuses
  // once on mount, which is the expected place to start on a chat page.
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  const trySend = () => {
    if (disabled || value.trim() === '') return;
    onSend();
  };

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        trySend();
      }}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter inserts a newline.
          if (event.key === 'Enter' && !event.shiftKey) {
            // Never send while an IME composition is active: committing a CJK
            // conversion candidate fires Enter, and sending half-composed text
            // into a non-idempotent 7-36 s turn permanently written into the
            // stateful session is destructive (review !62, major 5). keyCode
            // 229 covers Safari, which reports isComposing false on that
            // keydown.
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
            event.preventDefault();
            trySend();
          }
        }}
        disabled={disabled}
        maxLength={MAX_MESSAGE_LENGTH}
        rows={2}
        placeholder="Describe the dashboard you want..."
        aria-label="Message to the AI assistant"
        className="min-h-[56px] resize-none"
      />
      <Button type="submit" disabled={disabled || value.trim() === ''}>
        Send
      </Button>
    </form>
  );
}

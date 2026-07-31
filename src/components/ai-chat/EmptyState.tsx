import { Button } from '@/components/ui/button';
import { CHAT_SUGGESTIONS } from './suggestions';

interface EmptyStateProps {
  /** Fills the composer with the chip's text. Sends NOTHING — the user can
   *  edit before sending. */
  onPick: (text: string) => void;
  /** The session read failed (sessionQuery.isError). Adds one muted line; the
   *  page stays fully usable and sending starts a fresh session. */
  historyFailed: boolean;
}

export function EmptyState({ onPick, historyFailed }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">
          What do you want to monitor?
        </h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Describe the dashboard you need in plain language. The assistant may
          ask a few questions, then builds a dashboard you can preview against
          your own data.
        </p>
      </div>
      <div className="flex max-w-xl flex-wrap items-center justify-center gap-2">
        {CHAT_SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPick(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
      {historyFailed && (
        <p className="text-xs text-muted-foreground">
          Your chat history could not be loaded. You can still send a message —
          it starts a fresh conversation.
        </p>
      )}
    </div>
  );
}

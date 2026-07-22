import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/LocaleProvider';
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
  const { t } = useLocale();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">
          {t('ai_chat.empty_state.header.title.question')}
        </h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          {t('ai_chat.empty_state.header.subtitle.instruction')}
        </p>
      </div>
      <div className="flex max-w-xl flex-wrap items-center justify-center gap-2">
        {/* Intentionally un-keyed — the chip text becomes the prompt sent to the
            agent, and an ASCII-only test guards that. See suggestions.ts. */}
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
          {t('ai_chat.empty_state.history_error.paragraph.failure')}
        </p>
      )}
    </div>
  );
}

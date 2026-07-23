import { useEffect, useState } from 'react';

/**
 * Three-dot pulse shown while a chat turn is in flight. Mounted fresh for each
 * turn (the transcript renders it only while the mutation is pending), so the
 * slow-turn timer below resets per turn.
 *
 * It must NEVER print a time estimate: a measured build turn takes tens of
 * seconds while a question turn takes a few, the client cannot tell which it
 * is getting, and a wrong number is worse than none. After
 * STILL_WORKING_AFTER_MS it swaps in a fixed reassurance string with NO digit
 * — reviewers should reject any digit in a rendered string in this component
 * (the probe allows digits only in the timeout constant and Tailwind class
 * names, so this comment carries none either). No artificial delay is ever
 * added in either direction (mock and Bedrock render identically).
 */
const STILL_WORKING_AFTER_MS = 10_000;

const STILL_WORKING_TEXT = 'Still working — complex dashboards can take a while.';

export function TypingIndicator() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), STILL_WORKING_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div role="status" className="flex items-center gap-3 px-4 py-2">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.3s] motion-reduce:animate-none" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.15s] motion-reduce:animate-none" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce motion-reduce:animate-none" />
      </span>
      {slow ? (
        <span className="text-sm text-muted-foreground">{STILL_WORKING_TEXT}</span>
      ) : (
        <span className="sr-only">The assistant is preparing a reply.</span>
      )}
    </div>
  );
}

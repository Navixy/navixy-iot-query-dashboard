import { useMemo } from 'react';
import { parseMarkdown, type MdSpan } from './markdown';

/**
 * Renders agent prose through the typed tokenizer in ./markdown.ts. Emits
 * React elements only — no HTML string exists anywhere on this path (see the
 * tokenizer header for why that is a structural XSS guarantee, not a style
 * choice).
 *
 * Named MarkdownMessage (not Markdown) because a Markdown.tsx next to
 * markdown.ts does not survive a case-insensitive filesystem: tsc resolves
 * `./Markdown` extension-first to `Markdown.ts`, which case-insensitively
 * matches markdown.ts and fails with TS1261. The tokenizer keeps the
 * spec-pinned lowercase name; this file yields.
 */
function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'bold':
            return <strong key={i}>{span.value}</strong>;
          case 'code':
            return (
              <code
                key={i}
                className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all"
              >
                {span.value}
              </code>
            );
          default:
            return <span key={i}>{span.value}</span>;
        }
      })}
    </>
  );
}

export function MarkdownMessage({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'ol':
            return (
              <ol key={i} className="list-decimal space-y-1 pl-5">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Spans spans={item} />
                  </li>
                ))}
              </ol>
            );
          case 'ul':
            return (
              <ul key={i} className="list-disc space-y-1 pl-5">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Spans spans={item} />
                  </li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                <Spans spans={block.spans} />
              </p>
            );
        }
      })}
    </div>
  );
}

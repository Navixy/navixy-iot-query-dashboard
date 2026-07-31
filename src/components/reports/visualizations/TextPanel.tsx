import { useMemo } from 'react';
import type { Panel } from '@/types/dashboard-types';
import { toSafePanelHtml } from './panelHtml';

interface TextPanelProps {
  panel: Panel;
}

/**
 * Text Panel Component
 * Renders text panels with support for markdown, HTML, and plain text modes
 * 
 * According to the Navixy dashboard format:
 * - options.mode: 'markdown' | 'html' | 'text'
 * - options.content: The content string
 */
export function TextPanel({ panel }: TextPanelProps) {
  // Support both formats:
  // 1. Standard format: options.mode and options.content
  // 2. x-navixy format: x-navixy.text.format and x-navixy.text.content
  const navixyText = panel['x-navixy']?.text;
  const mode = panel.options?.mode || navixyText?.format || 'markdown';
  const content = (panel.options?.content as string | undefined) || navixyText?.content || '';

  // The ONE place content becomes HTML, for both HTML-producing modes. toSafePanelHtml
  // parses (markdown mode) and then SANITIZES. Panel content is no longer only
  // author-written: the AI chat preview renders an agent-authored dashboard through
  // this same component, and every agent dashboard ships a text panel. Injecting
  // marked's output raw let an event handler or a javascript: URL straight into the
  // DOM — and Apply persists the panel, so it would re-fire on every later open.
  // Do not reintroduce a path from `content` to __html that skips it. (DO-313)
  //
  // Memoized because this is the only expensive thing the component does and it is on
  // a hot path: `renderPanel` is a plain function, this component is not memoized, and
  // the renderer re-renders on every setPanelData — so an 11-panel preview re-parsed
  // and re-sanitized the disclaimer roughly twice per panel query. (round 4, finding 5)
  //
  // The try/catch covers BOTH modes. It used to wrap only markdown, which left html
  // mode able to throw straight through JSX — and there is no ErrorBoundary anywhere
  // in src, so that would blank the whole app, in the applied report as well as the
  // preview. Low likelihood, one line to remove. (round 4, finding 4)
  // `panel.options` is an untyped bag, so narrow once here rather than casting at
  // three later use sites. null = a mode with no HTML path (`text`, or anything
  // unrecognised).
  const htmlMode: 'markdown' | 'html' | null =
    mode === 'html' ? 'html' : mode === 'markdown' ? 'markdown' : null;

  const rendered = useMemo(() => {
    if (!content || !htmlMode) return null;
    try {
      return { html: toSafePanelHtml(content, htmlMode) };
    } catch (error) {
      console.error(`Error rendering ${htmlMode} panel content:`, error);
      return { error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }, [content, htmlMode]);

  const renderContent = () => {
    if (!content) {
      return (
        <div className="text-muted-foreground text-sm italic">
          No content provided
        </div>
      );
    }

    if (rendered && 'error' in rendered) {
      return (
        <div className="text-destructive text-sm">
          Error rendering {htmlMode}: {rendered.error}
        </div>
      );
    }

    if (rendered) {
      return (
        <div
          className="prose prose-sm dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      );
    }

    // 'text' and anything unrecognised: rendered as a text node, with no HTML
    // injection path at all.
    return (
      <div className="whitespace-pre-wrap text-sm">
        {content}
      </div>
    );
  };

  return (
    <div className="h-full w-full p-4 overflow-auto">
      {renderContent()}
    </div>
  );
}


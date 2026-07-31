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

  // Both HTML-producing branches below go through toSafePanelHtml, which parses
  // (markdown mode) and then SANITIZES. Panel content is no longer only
  // author-written: the AI chat preview renders an agent-authored dashboard through
  // this same component, and every agent dashboard ships a text panel. Injecting
  // marked's output raw let an event handler or a javascript: URL straight into the
  // DOM — and Apply persists the panel, so it would re-fire on every later open.
  // Do not reintroduce a path from `content` to __html that skips it. (DO-313)
  const renderContent = () => {
    if (!content) {
      return (
        <div className="text-muted-foreground text-sm italic">
          No content provided
        </div>
      );
    }

    switch (mode) {
      case 'markdown': {
        try {
          const html = toSafePanelHtml(content, 'markdown');
          return (
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        } catch (error) {
          console.error('Error parsing markdown:', error);
          return (
            <div className="text-destructive text-sm">
              Error rendering markdown: {error instanceof Error ? error.message : 'Unknown error'}
            </div>
          );
        }
      }
      
      case 'html': {
        return (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: toSafePanelHtml(content, 'html') }}
          />
        );
      }
      
      case 'text':
      default: {
        return (
          <div className="whitespace-pre-wrap text-sm">
            {content}
          </div>
        );
      }
    }
  };

  return (
    <div className="h-full w-full p-4 overflow-auto">
      {renderContent()}
    </div>
  );
}


/**
 * The one place a text panel's content becomes HTML.
 *
 * `TextPanel` injects this through `dangerouslySetInnerHTML`, so everything that
 * reaches the DOM from a panel's `options.content` passes here first.
 *
 * **Why sanitizing is required rather than tidy.** `marked` does not sanitize —
 * `<img src=x onerror=...>` and `[click](javascript:alert(1))` both survive it
 * verbatim — and panel content is no longer only author-written. The AI chat
 * feature (DO-313) previews an agent-authored dashboard through the same renderer,
 * and every agent dashboard ships a `text` panel; the backend's `validateDashboard`
 * short-circuits `type === 'text'` and never inspects `options.content`. The agent
 * also reads rows of the customer's IoT database while writing SQL, so a hostile row
 * is a plausible source with no malicious user involved. `auth_token` lives in
 * localStorage and its JWT carries both Postgres URLs in cleartext, and Apply
 * persists the panel verbatim — so an unsanitized panel is stored XSS that re-fires
 * on every later open of the report, not a one-off in a dialog.
 *
 * Sanitizing HERE, at the render seam, covers the preview, the applied report and
 * every dashboard that already exists. Filtering text panels out of the preview
 * would not: it leaves the saved report exposed and breaks the invariant that the
 * previewed bytes are the saved bytes.
 *
 * The chat bubble solves the same problem structurally instead — see
 * src/components/ai-chat/markdown.ts, which builds React elements and never
 * constructs an HTML string at all. That remains the stronger pattern; it is not
 * available here because panels legitimately carry author-written HTML.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Matches the options TextPanel has always parsed with. */
const MARKED_OPTIONS = { breaks: true, gfm: true } as const;

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Render a text panel's content as HTML that is safe to inject.
 *
 * @param mode `'markdown'` parses first; `'html'` sanitizes the content as given.
 *
 * No DOMPurify configuration is passed on purpose: the library's default profile is
 * what its own hardening is written against, and several of its published bypasses
 * are about `ADD_TAGS`/`USE_PROFILES`/hook customisation rather than the plain call.
 *
 * Fails CLOSED. Without a DOM (a non-browser runtime, a test outside jsdom)
 * DOMPurify cannot sanitize and reports `isSupported: false` — in that case the
 * content is escaped to text rather than passed through, because silently returning
 * unsanitized HTML is the one outcome this function exists to prevent.
 */
export function toSafePanelHtml(content: string, mode: 'markdown' | 'html'): string {
  const rendered = mode === 'html'
    ? content
    : (marked.parse(content, MARKED_OPTIONS) as string);

  if (!DOMPurify.isSupported) {
    return escapeHtml(content);
  }
  return DOMPurify.sanitize(rendered);
}

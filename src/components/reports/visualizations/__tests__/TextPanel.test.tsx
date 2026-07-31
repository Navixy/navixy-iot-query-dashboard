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
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { TextPanel } from '../TextPanel';
import type { Panel } from '@/types/dashboard-types';

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
});

/**
 * @vitest-environment jsdom
 *
 * The sanitizer at the text-panel seam. jsdom because DOMPurify needs a DOM — and
 * because the fail-closed branch below is what happens when it does not have one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';
import { toSafePanelHtml } from '../panelHtml';
// The real agent artifact: its panel 1 is the markdown text panel that every agent
// dashboard ships, and therefore the content that actually travels this path.
import agentArtifact from '@/components/reports/__tests__/fixtures/agent-artifact.json';

describe('the hole this closes', () => {
  it('marked itself passes an event handler and a javascript: URL straight through', () => {
    // Not a claim about our code — a claim about the parser it used to inject raw.
    expect(marked.parse('note <img src=x onerror="alert(1)">', { breaks: true, gfm: true }))
      .toContain('onerror');
    expect(marked.parse('[click](javascript:alert(1))', { breaks: true, gfm: true }))
      .toContain('javascript:');
  });
});

describe('toSafePanelHtml — markdown', () => {
  it('strips an inline event handler', () => {
    const html = toSafePanelHtml('AI note. <img src=x onerror="alert(1)">', 'markdown');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('strips a javascript: link', () => {
    const html = toSafePanelHtml('[click](javascript:alert(1))', 'markdown');
    expect(html).not.toContain('javascript:');
  });

  it('strips a script tag', () => {
    const html = toSafePanelHtml('before <script>alert(1)</script> after', 'markdown');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('strips an svg onload payload', () => {
    expect(toSafePanelHtml('<svg onload=alert(1)>', 'markdown')).not.toContain('onload');
  });

  it('strips an iframe', () => {
    expect(toSafePanelHtml('<iframe src="https://evil.example"></iframe>', 'markdown'))
      .not.toContain('<iframe');
  });

  it('keeps ordinary markdown working', () => {
    const html = toSafePanelHtml('# Title\n\n- one\n- two\n\n**bold** and `code`', 'markdown');
    expect(html).toContain('<h1');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('keeps a normal link', () => {
    expect(toSafePanelHtml('[docs](https://example.com/x)', 'markdown'))
      .toContain('href="https://example.com/x"');
  });

  it('honours the breaks option TextPanel has always parsed with', () => {
    expect(toSafePanelHtml('one\ntwo', 'markdown')).toContain('<br>');
  });

  it('renders the real agent disclaimer panel unharmed', () => {
    const panel = agentArtifact.panels[0] as { type: string; options?: { mode?: string; content?: string } };
    expect(panel.type).toBe('text');
    const html = toSafePanelHtml(panel.options?.content ?? '', 'markdown');

    expect(html).toContain('This dashboard was created using an AI agent.');
    expect(html).toContain('<code>738dcdfe-f700-46e4-9802-510f2d7cabf3</code>');
    expect(html).not.toContain('<script');
  });
});

describe('toSafePanelHtml — html mode', () => {
  it('sanitizes content given as raw HTML, which used to be injected verbatim', () => {
    const html = toSafePanelHtml('<p>ok</p><img src=x onerror="alert(1)">', 'html');
    expect(html).toContain('<p>ok</p>');
    expect(html).not.toContain('onerror');
  });

  it('does not markdown-parse html-mode content', () => {
    expect(toSafePanelHtml('# not a heading', 'html')).not.toContain('<h1');
  });

  it('keeps benign author markup', () => {
    const html = toSafePanelHtml('<div class="note"><b>hi</b><a href="/x">link</a></div>', 'html');
    expect(html).toContain('<b>hi</b>');
    expect(html).toContain('href="/x"');
  });
});

describe('author markup the default config would have broken', () => {
  it('keeps target on a link, and forces rel so the opener handle is not shared', () => {
    const html = toSafePanelHtml('<a href="https://docs.example.com" target="_blank">Runbook</a>', 'html');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('treats a tag the same wherever it sits in the string', () => {
    // The parser hoists a LEADING style/title/meta into <head> and DOMPurify returns
    // only <body>, so an ALLOWED head-hoistable tag would behave differently depending
    // on whether text precedes it. Refusing <style> outright is what settles that —
    // this pins the outcome, so re-allowing the tag fails here rather than shipping
    // the asymmetry.
    const leading = toSafePanelHtml('<style>.k{color:red}</style><p class="k">C</p>', 'html');
    const trailing = toSafePanelHtml('<p class="k">C</p><style>.k{color:red}</style>', 'html');
    expect(leading).not.toContain('<style');
    expect(trailing).not.toContain('<style');
    expect(leading).toContain('<p class="k">C</p>');
    expect(trailing).toContain('<p class="k">C</p>');
  });

  it('keeps the class attribute, which is how a panel styles itself now', () => {
    expect(toSafePanelHtml('<p class="text-lg font-bold">Big</p>', 'html'))
      .toContain('class="text-lg font-bold"');
  });
});

describe('the injection surface script-blocking alone leaves open', () => {
  it('drops a document-wide style block that could hide the app', () => {
    const html = toSafePanelHtml('AI summary.\n<style>#root>*{display:none}</style>', 'markdown');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('display:none');
    expect(html).toContain('AI summary.');
  });

  it('drops an inline style that could cover the page', () => {
    const html = toSafePanelHtml('<div style="position:fixed;inset:0;z-index:9999">gotcha</div>', 'html');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('position:fixed');
    expect(html).toContain('gotcha');
  });

  it('drops a credential form pointing at another origin', () => {
    const html = toSafePanelHtml(
      '<form action="https://evil.example" method="POST"><input name="pw" type="password"><button>Go</button></form>',
      'html',
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('evil.example');
  });

  it('drops the same surfaces when they arrive through markdown', () => {
    const html = toSafePanelHtml('note\n\n<form action="https://evil.example"><input name="pw"></form>', 'markdown');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).toContain('note');
  });
});

describe('without a DOM, it fails CLOSED', () => {
  // The docblock cites this branch as the reason the file chose jsdom, and nothing
  // entered it: returning `rendered` instead of escaping kept every other test green.
  //
  // The REAL library is asked for an instance bound to a runtime with no document —
  // which is exactly what it builds under Node or SSR. `sanitize` is not stubbed and
  // no flag is overwritten; the module under test simply holds an instance that
  // reports `isSupported: false`. (Flipping the shared singleton's flag no longer
  // reaches it: the module keeps a private instance now. Round 4, finding 6.)
  const withoutDom = async () => {
    vi.doMock('dompurify', async () => {
      const actual = await vi.importActual<typeof import('dompurify')>('dompurify');
      return { default: () => actual.default({} as never) };
    });
    vi.resetModules();
    return (await import('../panelHtml')).toSafePanelHtml;
  };

  afterEach(() => {
    vi.doUnmock('dompurify');
    vi.resetModules();
  });

  it('escapes the content to text rather than passing HTML through', async () => {
    const safeHtml = await withoutDom();
    const html = safeHtml('<img src=x onerror="alert(1)">', 'markdown');

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('onerror=&quot;alert(1)&quot;');
  });

  it('escapes html-mode content the same way', async () => {
    const safeHtml = await withoutDom();
    expect(safeHtml('<b>hi</b>', 'html')).toBe('&lt;b&gt;hi&lt;/b&gt;');
  });

  it('escapes the RAW content, never the parsed markdown', async () => {
    const safeHtml = await withoutDom();
    // Escaping marked's output would leak the parser's own tags as visible text.
    expect(safeHtml('# Title', 'markdown')).toBe('# Title');
  });
});

describe('the sanitizer instance is private to this module', () => {
  it('does not install its rel hook on the shared DOMPurify singleton', async () => {
    // Whether some future DOMPurify.sanitize() elsewhere in src inherits our
    // rel-forcing hook must not depend on whether a text panel rendered first.
    const shared = (await vi.importActual<typeof import('dompurify')>('dompurify')).default;

    expect(toSafePanelHtml('<a href="https://x.example" target="_blank">go</a>', 'html'))
      .toContain('rel="noopener noreferrer"');
    expect(shared.sanitize('<a href="https://x.example" target="_blank">go</a>', { ADD_ATTR: ['target'] }))
      .not.toContain('rel=');
  });
});

describe('edge cases', () => {
  it('returns empty for empty content', () => {
    expect(toSafePanelHtml('', 'markdown')).toBe('');
    expect(toSafePanelHtml('', 'html')).toBe('');
  });

  it('never returns a string carrying an on* handler, whatever the mode', () => {
    const payloads = [
      '<img src=x onerror=alert(1)>',
      '<body onload=alert(1)>',
      '<a href="jAvAsCrIpT:alert(1)">x</a>',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<form><button formaction="javascript:alert(1)">x</button></form>',
    ];
    for (const payload of payloads) {
      for (const mode of ['markdown', 'html'] as const) {
        const html = toSafePanelHtml(payload, mode);
        expect(html.toLowerCase()).not.toMatch(/\son\w+\s*=/);
        expect(html.toLowerCase()).not.toContain('javascript:');
      }
    }
  });
});

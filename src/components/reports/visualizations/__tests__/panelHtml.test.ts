/**
 * @vitest-environment jsdom
 *
 * The sanitizer at the text-panel seam. jsdom because DOMPurify needs a DOM — and
 * because the fail-closed branch below is what happens when it does not have one.
 */
import { describe, expect, it } from 'vitest';
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

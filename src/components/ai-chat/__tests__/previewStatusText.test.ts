import { describe, expect, it } from 'vitest';
import { makeT } from '@/i18n/makeT';
import { getMessagePack } from '@/i18n/messagePacks';
import { describePanelStatus } from '../previewStatusText';

// The real English translator, so these assertions pin the copy a user actually sees
// rather than a stub. The banner is localized: it takes `t` because the module is pure
// and unit-tested outside React. Counts read "noun first, number after the colon" —
// the runtime has no plural rules (no ICU), so a count never has to agree with a noun.
const t = makeT(getMessagePack('en_US'));

describe('describePanelStatus', () => {
  it('does not claim the dashboard is empty before the renderer has counted it', () => {
    // null is "nobody has counted yet", which is NOT the same as "counted, and there
    // are none" — folding them together made every preview open on
    // "This dashboard has no data panels."
    expect(describePanelStatus(null, t)).toEqual({
      text: 'Loading panels…',
      severity: 'muted',
      busy: true,
    });
    expect(describePanelStatus(null, t).text).not.toContain('no data panels');
  });

  it('still says so once the renderer has counted and there really are none', () => {
    expect(describePanelStatus({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 0 }, t).text)
      .toBe('This dashboard has no data panels.');
  });

  it('reports how many panels are still executing', () => {
    const banner = describePanelStatus({ total: 4, loaded: 1, failed: 0, pending: 3, unverifiable: 0 }, t);
    expect(banner).toEqual({ text: 'Loading panels: 3…', severity: 'muted', busy: true });
  });

  it('says nothing alarming when every panel loaded', () => {
    expect(describePanelStatus({ total: 9, loaded: 9, failed: 0, pending: 0, unverifiable: 0 }, t)).toEqual({
      text: 'All panels loaded: 9.',
      severity: 'muted',
      busy: false,
    });
  });

  it('is destructive and counts the failures when a panel failed', () => {
    const banner = describePanelStatus({ total: 10, loaded: 7, failed: 3, pending: 0, unverifiable: 0 }, t);
    expect(banner.severity).toBe('destructive');
    expect(banner.text).toContain('Panels loaded: 7 of 10.');
    expect(banner.text).toContain('Failed panels: 3');
    expect(banner.text).toContain('before applying');
  });

  it('says a dashboard with no data panels has none', () => {
    expect(describePanelStatus({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 0 }, t)).toEqual({
      text: 'This dashboard has no data panels.',
      severity: 'muted',
      busy: false,
    });
  });

  it('reports the observed agent failure — one bad panel among three', () => {
    // The real agent dashboard: three SQL panels, one hallucinated column.
    const banner = describePanelStatus({ total: 3, loaded: 2, failed: 1, pending: 0, unverifiable: 0 }, t);
    expect(banner.severity).toBe('destructive');
    expect(banner.text).toContain('Panels loaded: 2 of 3.');
    expect(banner.text).toContain('Failed panels: 1');
  });

  it('reads correctly when a count is one', () => {
    // The counts that the old English-plural wording had to special-case. The
    // noun-first form needs no special case, so these simply read the same way.
    expect(describePanelStatus({ total: 2, loaded: 1, failed: 0, pending: 1, unverifiable: 0 }, t).text)
      .toBe('Loading panels: 1…');
    expect(describePanelStatus({ total: 1, loaded: 1, failed: 0, pending: 0, unverifiable: 0 }, t).text)
      .toBe('All panels loaded: 1.');
    expect(describePanelStatus({ total: 1, loaded: 0, failed: 1, pending: 0, unverifiable: 0 }, t).text)
      .toBe('Panels loaded: 0 of 1. Failed panels: 1. Check them before applying.');
  });

  /**
   * A panel the preview could not execute is not a panel that passed. It is saved all
   * the same, so the banner has to say so — the alternative, and the previous
   * behaviour, was for it to disappear from every number on screen.
   * (!64 review round 6, finding 3)
   */
  describe('panels the preview could not check', () => {
    it('never says everything loaded while something went unchecked', () => {
      const banner = describePanelStatus({ total: 2, loaded: 2, failed: 0, pending: 0, unverifiable: 1 }, t);
      expect(banner.text)
        .toBe('All panels loaded: 2. Panels not checked: 1. No SQL to run.');
      expect(banner.severity).toBe('destructive');
      expect(banner.busy).toBe(false);
    });

    it('says it alongside a failure rather than instead of one', () => {
      const banner = describePanelStatus({ total: 3, loaded: 2, failed: 1, pending: 0, unverifiable: 2 }, t);
      expect(banner.text).toContain('Failed panels: 1');
      expect(banner.text).toContain('Panels not checked: 2. No SQL to run.');
      expect(banner.severity).toBe('destructive');
    });

    it('does not call a dashboard empty when it is only unrunnable', () => {
      // The old text for `total: 0` was "This dashboard has no data panels." — said
      // over a panel that is saved and renders a "No SQL configured" placeholder.
      const banner = describePanelStatus({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 1 }, t);
      expect(banner.text).toBe('Panels not checked: 1. No SQL to run.');
      expect(banner.text).not.toContain('no data panels');
      expect(banner.severity).toBe('destructive');
    });

    it('keeps the countdown clean while panels are still executing', () => {
      // Nothing about the unchecked count changes as queries land, and a countdown is
      // hard enough to read without a second number beside it.
      expect(describePanelStatus({ total: 4, loaded: 1, failed: 0, pending: 3, unverifiable: 1 }, t))
        .toEqual({ text: 'Loading panels: 3…', severity: 'muted', busy: true });
    });
  });

  it('never claims success while a failure is on screen', () => {
    for (const failed of [1, 2, 5]) {
      const banner = describePanelStatus({ total: failed + 1, loaded: 1, failed, pending: 0, unverifiable: 0 }, t);
      expect(banner.severity).toBe('destructive');
      expect(banner.text).not.toContain('All panels loaded');
    }
  });
});

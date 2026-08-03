import { describe, expect, it } from 'vitest';
import { describePanelStatus } from '../previewStatusText';

describe('describePanelStatus', () => {
  it('does not claim the dashboard is empty before the renderer has counted it', () => {
    // null is "nobody has counted yet", which is NOT the same as "counted, and there
    // are none" — folding them together made every preview open on
    // "This dashboard has no data panels."
    expect(describePanelStatus(null)).toEqual({
      text: 'Loading panels…',
      severity: 'muted',
      busy: true,
    });
    expect(describePanelStatus(null).text).not.toContain('no data panels');
  });

  it('still says so once the renderer has counted and there really are none', () => {
    expect(describePanelStatus({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 0 }).text)
      .toBe('This dashboard has no data panels.');
  });

  it('reports how many panels are still executing', () => {
    const banner = describePanelStatus({ total: 4, loaded: 1, failed: 0, pending: 3, unverifiable: 0 });
    expect(banner).toEqual({ text: 'Loading 3 panels…', severity: 'muted', busy: true });
  });

  it('says nothing alarming when every panel loaded', () => {
    expect(describePanelStatus({ total: 9, loaded: 9, failed: 0, pending: 0, unverifiable: 0 })).toEqual({
      text: 'All 9 panels loaded.',
      severity: 'muted',
      busy: false,
    });
  });

  it('is destructive and counts the failures when a panel failed', () => {
    const banner = describePanelStatus({ total: 10, loaded: 7, failed: 3, pending: 0, unverifiable: 0 });
    expect(banner.severity).toBe('destructive');
    expect(banner.text).toContain('7 of 10 panels loaded.');
    expect(banner.text).toContain('3 panels failed');
    expect(banner.text).toContain('before applying');
  });

  it('says a dashboard with no data panels has none', () => {
    expect(describePanelStatus({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 0 })).toEqual({
      text: 'This dashboard has no data panels.',
      severity: 'muted',
      busy: false,
    });
  });

  it('reports the observed agent failure in the singular — the off-by-one that would ship', () => {
    // The real agent dashboard: three SQL panels, one hallucinated column.
    const banner = describePanelStatus({ total: 3, loaded: 2, failed: 1, pending: 0, unverifiable: 0 });
    expect(banner.severity).toBe('destructive');
    expect(banner.text).toContain('2 of 3 panels loaded.');
    expect(banner.text).toContain('1 panel failed');
    expect(banner.text).not.toContain('1 panels');
  });

  it('does not pluralise a single pending or single total panel', () => {
    expect(describePanelStatus({ total: 2, loaded: 1, failed: 0, pending: 1, unverifiable: 0 }).text)
      .toBe('Loading 1 panel…');
    expect(describePanelStatus({ total: 1, loaded: 1, failed: 0, pending: 0, unverifiable: 0 }).text)
      .toBe('1 panel loaded.');
    expect(describePanelStatus({ total: 1, loaded: 0, failed: 1, pending: 0, unverifiable: 0 }).text)
      .toBe('0 of 1 panel loaded. 1 panel failed — check it before applying.');
  });

  /**
   * A panel the preview could not execute is not a panel that passed. It is saved all
   * the same, so the banner has to say so — the alternative, and the previous
   * behaviour, was for it to disappear from every number on screen.
   * (!64 review round 6, finding 3)
   */
  describe('panels the preview could not check', () => {
    it('never says "All N loaded" while something went unchecked', () => {
      const banner = describePanelStatus({ total: 2, loaded: 2, failed: 0, pending: 0, unverifiable: 1 });
      expect(banner.text)
        .toBe('All 2 panels loaded. 1 panel could not be checked — it has no SQL to run.');
      expect(banner.severity).toBe('destructive');
      expect(banner.busy).toBe(false);
    });

    it('says it alongside a failure rather than instead of one', () => {
      const banner = describePanelStatus({ total: 3, loaded: 2, failed: 1, pending: 0, unverifiable: 2 });
      expect(banner.text).toContain('1 panel failed');
      expect(banner.text).toContain('2 panels could not be checked — they have no SQL to run.');
      expect(banner.severity).toBe('destructive');
    });

    it('does not call a dashboard empty when it is only unrunnable', () => {
      // The old text for `total: 0` was "This dashboard has no data panels." — said
      // over a panel that is saved and renders a "No SQL configured" placeholder.
      const banner = describePanelStatus({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 1 });
      expect(banner.text).toBe('1 panel could not be checked — it has no SQL to run.');
      expect(banner.text).not.toContain('no data panels');
      expect(banner.severity).toBe('destructive');
    });

    it('keeps the countdown clean while panels are still executing', () => {
      // Nothing about the unchecked count changes as queries land, and a countdown is
      // hard enough to read without a second number beside it.
      expect(describePanelStatus({ total: 4, loaded: 1, failed: 0, pending: 3, unverifiable: 1 }))
        .toEqual({ text: 'Loading 3 panels…', severity: 'muted', busy: true });
    });
  });

  it('never claims success while a failure is on screen', () => {
    for (const failed of [1, 2, 5]) {
      const banner = describePanelStatus({ total: failed + 1, loaded: 1, failed, pending: 0, unverifiable: 0 });
      expect(banner.severity).toBe('destructive');
      expect(banner.text).not.toContain('All ');
    }
  });
});

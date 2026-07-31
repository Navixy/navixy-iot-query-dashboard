import { describe, expect, it } from 'vitest';
import { describePanelStatus } from '../previewStatusText';

describe('describePanelStatus', () => {
  it('reports how many panels are still executing', () => {
    const banner = describePanelStatus({ total: 4, loaded: 1, failed: 0, pending: 3 });
    expect(banner).toEqual({ text: 'Loading 3 panels…', severity: 'muted', busy: true });
  });

  it('says nothing alarming when every panel loaded', () => {
    expect(describePanelStatus({ total: 9, loaded: 9, failed: 0, pending: 0 })).toEqual({
      text: 'All 9 panels loaded.',
      severity: 'muted',
      busy: false,
    });
  });

  it('is destructive and counts the failures when a panel failed', () => {
    const banner = describePanelStatus({ total: 10, loaded: 7, failed: 3, pending: 0 });
    expect(banner.severity).toBe('destructive');
    expect(banner.text).toContain('7 of 10 panels loaded.');
    expect(banner.text).toContain('3 panels failed');
    expect(banner.text).toContain('before applying');
  });

  it('says a dashboard with no data panels has none', () => {
    expect(describePanelStatus({ total: 0, loaded: 0, failed: 0, pending: 0 })).toEqual({
      text: 'This dashboard has no data panels.',
      severity: 'muted',
      busy: false,
    });
  });

  it('reports the observed agent failure in the singular — the off-by-one that would ship', () => {
    // The real agent dashboard: three SQL panels, one hallucinated column.
    const banner = describePanelStatus({ total: 3, loaded: 2, failed: 1, pending: 0 });
    expect(banner.severity).toBe('destructive');
    expect(banner.text).toContain('2 of 3 panels loaded.');
    expect(banner.text).toContain('1 panel failed');
    expect(banner.text).not.toContain('1 panels');
  });

  it('does not pluralise a single pending or single total panel', () => {
    expect(describePanelStatus({ total: 2, loaded: 1, failed: 0, pending: 1 }).text)
      .toBe('Loading 1 panel…');
    expect(describePanelStatus({ total: 1, loaded: 1, failed: 0, pending: 0 }).text)
      .toBe('1 panel loaded.');
    expect(describePanelStatus({ total: 1, loaded: 0, failed: 1, pending: 0 }).text)
      .toBe('0 of 1 panel loaded. 1 panel failed — check it before applying.');
  });

  it('never claims success while a failure is on screen', () => {
    for (const failed of [1, 2, 5]) {
      const banner = describePanelStatus({ total: failed + 1, loaded: 1, failed, pending: 0 });
      expect(banner.severity).toBe('destructive');
      expect(banner.text).not.toContain('All ');
    }
  });
});

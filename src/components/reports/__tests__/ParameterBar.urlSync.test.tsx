/**
 * @vitest-environment jsdom
 *
 * That `ParameterBar` actually forwards `syncParametersToUrl` to the hook.
 *
 * The chain is PreviewDialog → DashboardRenderer → ParameterBar → useParameterUrlSync.
 * Both ends were pinned and the middle was not: dropping the argument here left every
 * other test green while the chat URL filled up again. Same class of gap as the
 * TextPanel one. (!64 review round 3, finding 4)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Dashboard } from '@/types/dashboard-types';

const syncCalls = vi.hoisted(() => ({ enabled: [] as Array<boolean | undefined> }));

vi.mock('@/hooks/use-parameter-url-sync', () => ({
  useParameterUrlSync: (
    _values: unknown, _onChange: unknown, _defaults: unknown,
    _arrayParamNames: unknown, enabled?: boolean,
  ) => { syncCalls.enabled.push(enabled); },
}));

vi.mock('@/services/api', () => ({ apiService: { executeSQL: vi.fn() } }));
vi.mock('@/contexts/DatetimePrefsContext', () => ({
  useDatetimePrefs: () => ({ prefs: { timezone: 'UTC', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' } }),
}));

const { ParameterBar } = await import('../ParameterBar');

const dashboard = {
  title: 'D', time: { from: 'now-24h', to: 'now' }, panels: [],
} as unknown as Dashboard;

function Probe({ sync }: { sync?: boolean }) {
  const location = useLocation();
  return createElement('div', null,
    createElement('span', { 'data-testid': 'search' }, location.search),
    createElement(ParameterBar, {
      dashboard, values: {}, onChange: () => {},
      ...(sync === undefined ? {} : { syncParametersToUrl: sync }),
    }));
}

const mount = (sync?: boolean) =>
  render(createElement(MemoryRouter, null, createElement(Probe, { sync })));

afterEach(() => { cleanup(); syncCalls.enabled.length = 0; });

describe('ParameterBar → useParameterUrlSync', () => {
  it('forwards false, so a preview cannot write to the page URL', () => {
    mount(false);
    expect(syncCalls.enabled.at(-1)).toBe(false);
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('forwards true when asked explicitly', () => {
    mount(true);
    expect(syncCalls.enabled.at(-1)).toBe(true);
  });

  it('defaults to true, so a report at its own URL keeps sharing its filters', () => {
    mount();
    expect(syncCalls.enabled.at(-1)).toBe(true);
  });
});

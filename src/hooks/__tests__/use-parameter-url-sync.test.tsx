/**
 * @vitest-environment jsdom
 *
 * The `enabled` flag on the parameter/URL sync.
 *
 * The hook is shared: a report at its own URL depends on the round-trip (that is how
 * a filtered dashboard gets shared), while the AI chat preview must not touch
 * `/app/chat`'s query string — it owns no parameters, never clears them, and would
 * hand one preview's time window to the next. Both halves are pinned here, because a
 * regression in the enabled half is worse than the bug the flag fixes.
 * (!64 review round 3, finding 4)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, useState, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useParameterUrlSync } from '../use-parameter-url-sync';
import type { ParameterValues } from '@/components/reports/ParameterBar';

/** Drives the hook and exposes both the values it settled on and the live URL. */
function Harness({ defaults, enabled }: { defaults: ParameterValues; enabled: boolean }) {
  const [values, setValues] = useState<ParameterValues>({});
  useParameterUrlSync(values, setValues, defaults, [], enabled);
  const location = useLocation();

  return createElement('div', null,
    createElement('span', { 'data-testid': 'values' }, JSON.stringify(values)),
    createElement('span', { 'data-testid': 'search' }, location.search),
    createElement('button', {
      'data-testid': 'change',
      onClick: () => setValues({ ...values, region: 'north' }),
    }, 'change'));
}

const mount = (ui: ReactNode, url: string) =>
  render(createElement(MemoryRouter, { initialEntries: [url] }, ui));

afterEach(cleanup);

const values = () => JSON.parse(screen.getByTestId('values').textContent || '{}');
const search = () => screen.getByTestId('search').textContent;

describe('useParameterUrlSync, enabled (a report at its own URL)', () => {
  it('adopts parameters from the URL', () => {
    mount(createElement(Harness, { defaults: { region: 'south' }, enabled: true }), '/r/1?region=north');
    expect(values().region).toBe('north');
  });

  it('writes changed values back to the URL', () => {
    mount(createElement(Harness, { defaults: { region: 'south' }, enabled: true }), '/r/1');
    act(() => { screen.getByTestId('change').click(); });
    expect(search()).toContain('region=north');
  });
});

describe('useParameterUrlSync, turned on after mount', () => {
  it('publishes what changed while it was off, instead of swallowing one write', () => {
    // Unreachable today — both call sites pass a literal — but the guard that skips
    // the mount write used to be consumed by the run that ENABLES the sync, so the
    // first write after enabling went nowhere. (!64 review round 4, finding 3)
    const tree = (enabled: boolean) =>
      createElement(MemoryRouter, { initialEntries: ['/r/1'] },
        createElement(Harness, { defaults: { region: 'south' }, enabled }));

    const view = render(tree(false));
    act(() => { screen.getByTestId('change').click(); });
    expect(search()).toBe('');

    view.rerender(tree(true));
    expect(search()).toContain('region=north');
  });
});

describe('useParameterUrlSync, disabled (a dashboard that is a guest on the route)', () => {
  it('ignores parameters already in the URL', () => {
    // Preview B must run its own `time`, not whatever preview A left behind.
    mount(createElement(Harness, { defaults: { region: 'south' }, enabled: false }), '/app/chat?region=north');
    expect(values().region).toBe('south');
  });

  it('still applies the defaults, so the panels have their values', () => {
    mount(createElement(Harness, { defaults: { region: 'south', limit: 10 }, enabled: false }), '/app/chat');
    expect(values()).toEqual({ region: 'south', limit: 10 });
  });

  it('writes nothing to the URL when values change', () => {
    mount(createElement(Harness, { defaults: { region: 'south' }, enabled: false }), '/app/chat');
    act(() => { screen.getByTestId('change').click(); });

    expect(values().region).toBe('north');
    expect(search()).toBe('');
  });
});

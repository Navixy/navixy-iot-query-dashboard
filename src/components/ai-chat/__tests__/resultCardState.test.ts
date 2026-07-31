import { describe, expect, it } from 'vitest';
import { resultCardState } from '../resultCardState';

describe('resultCardState', () => {
  it('lets a viewer preview but not apply, and names the role as the reason', () => {
    expect(resultCardState('viewer', false, false)).toEqual({
      canPreview: true,
      canApply: false,
      applyDisabledReason: 'role',
    });
  });

  it('enables both for an editor with no turn in flight', () => {
    expect(resultCardState('editor', false, false)).toEqual({
      canPreview: true,
      canApply: true,
      applyDisabledReason: null,
    });
  });

  it('enables both for an admin with no turn in flight', () => {
    expect(resultCardState('admin', false, false).canApply).toBe(true);
  });

  it('disables apply while a turn is pending, and STILL allows preview', () => {
    const state = resultCardState('admin', true, false);
    expect(state.canApply).toBe(false);
    expect(state.applyDisabledReason).toBe('pending');
    // Preview is read-only and harmless — it must never be gated (R27).
    expect(state.canPreview).toBe(true);
  });

  it('disables apply while an apply is already running', () => {
    expect(resultCardState('editor', false, true)).toEqual({
      canPreview: true,
      canApply: false,
      applyDisabledReason: 'applying',
    });
  });

  it('disables apply when the role is not yet known', () => {
    expect(resultCardState(undefined, false, false)).toEqual({
      canPreview: true,
      canApply: false,
      applyDisabledReason: 'role',
    });
  });

  it('prefers the durable reason over a transient one for a viewer', () => {
    // A viewer who waits for the turn to finish still cannot apply, so naming
    // "pending" would send them back for nothing.
    expect(resultCardState('viewer', true, true).applyDisabledReason).toBe('role');
  });

  it('never reports a reason while apply is enabled', () => {
    for (const role of ['admin', 'editor'] as const) {
      const state = resultCardState(role, false, false);
      expect(state.canApply).toBe(true);
      expect(state.applyDisabledReason).toBeNull();
    }
  });
});

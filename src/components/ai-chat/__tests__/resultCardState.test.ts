import { describe, expect, it } from 'vitest';
import { resultCardState } from '../resultCardState';

/** The state a card is in once its preview has run to completion. */
const previewed = { open: false, completed: true };
/** ...and before it has been opened at all. */
const unpreviewed = { open: false, completed: false };

describe('resultCardState', () => {
  it('lets a viewer preview but not apply, and names the role as the reason', () => {
    expect(resultCardState('viewer', false, false, previewed)).toEqual({
      canPreview: true,
      canApply: false,
      applyDisabledReason: 'role',
    });
  });

  it('enables both for an editor with no turn in flight', () => {
    expect(resultCardState('editor', false, false, previewed)).toEqual({
      canPreview: true,
      canApply: true,
      applyDisabledReason: null,
    });
  });

  it('enables both for an admin with no turn in flight', () => {
    expect(resultCardState('admin', false, false, previewed).canApply).toBe(true);
  });

  it('disables apply while a turn is pending, and STILL allows preview', () => {
    const state = resultCardState('admin', true, false, previewed);
    expect(state.canApply).toBe(false);
    expect(state.applyDisabledReason).toBe('pending');
    // Preview is read-only and harmless — it must never be gated (R27).
    expect(state.canPreview).toBe(true);
  });

  it('disables apply while an apply is already running', () => {
    expect(resultCardState('editor', false, false, { open: false, completed: true }))
      .toEqual({ canPreview: true, canApply: true, applyDisabledReason: null });
    expect(resultCardState('editor', false, true, previewed)).toEqual({
      canPreview: true,
      canApply: false,
      applyDisabledReason: 'applying',
    });
  });

  it('disables apply when the role is not yet known', () => {
    expect(resultCardState(undefined, false, false, previewed)).toEqual({
      canPreview: true,
      canApply: false,
      applyDisabledReason: 'role',
    });
  });

  it('prefers the durable reason over a transient one for a viewer', () => {
    // A viewer who waits for the turn to finish still cannot apply, so naming
    // "pending" would send them back for nothing.
    expect(resultCardState('viewer', true, true, previewed).applyDisabledReason).toBe('role');
  });

  it('never reports a reason while apply is enabled', () => {
    for (const role of ['admin', 'editor'] as const) {
      const state = resultCardState(role, false, false, previewed);
      expect(state.canApply).toBe(true);
      expect(state.applyDisabledReason).toBeNull();
    }
  });
});

/**
 * R27, expressed as a rule rather than as a warning in a docblock: the preview is the
 * feature's only correctness control, and a control the user can walk past is advisory.
 * Every one of these cases used to enable Apply. (!64 review round 6, finding 1)
 */
describe('resultCardState — the preview gate', () => {
  it('refuses an editor who has not previewed this result', () => {
    expect(resultCardState('editor', false, false, unpreviewed)).toEqual({
      canPreview: true,
      canApply: false,
      applyDisabledReason: 'preview',
    });
  });

  it('refuses an admin the same way — this is not a permission', () => {
    expect(resultCardState('admin', false, false, unpreviewed).applyDisabledReason)
      .toBe('preview');
  });

  it('still refuses while the preview is open but has not finished', () => {
    // Panels executing, globals loading, or a schema that could not be read: none of
    // them has produced evidence, and the dialog is where the user is looking.
    expect(resultCardState('editor', false, false, { open: true, completed: false }))
      .toEqual({ canPreview: true, canApply: false, applyDisabledReason: 'previewing' });
  });

  it('names the reason differently once the dialog is open, because the ask differs', () => {
    // "Preview this dashboard first" is wrong advice for someone already staring at it.
    expect(resultCardState('editor', false, false, unpreviewed).applyDisabledReason)
      .toBe('preview');
    expect(resultCardState('editor', false, false, { open: true, completed: false })
      .applyDisabledReason).toBe('previewing');
  });

  it('unlocks once the preview has finished, whatever it found', () => {
    // A failed panel does not block Apply — a user may legitimately save 9 of 10 and
    // fix the last in the layout editor. What is required is that the execution
    // HAPPENED and its result was on screen, not that it was clean.
    expect(resultCardState('editor', false, false, { open: true, completed: true }).canApply)
      .toBe(true);
    expect(resultCardState('editor', false, false, { open: false, completed: true }).canApply)
      .toBe(true);
  });

  it('keeps the role reason ahead of the preview one', () => {
    // A viewer cannot apply however thoroughly they preview.
    expect(resultCardState('viewer', false, false, unpreviewed).applyDisabledReason)
      .toBe('role');
  });

  it('never gates PREVIEW on anything, which is the other half of R27', () => {
    for (const role of ['admin', 'editor', 'viewer', undefined] as const) {
      for (const preview of [previewed, unpreviewed, { open: true, completed: false }]) {
        expect(resultCardState(role, true, true, preview).canPreview).toBe(true);
      }
    }
  });
});

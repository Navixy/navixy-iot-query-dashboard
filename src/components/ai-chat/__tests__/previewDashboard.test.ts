import { describe, expect, it } from 'vitest';
import { toPreviewDashboard } from '../previewDashboard';
// The real agent artifact, which ships `"refresh": "5m"` — the reason this
// module exists rather than the schema going straight to the renderer.
import agentArtifact from '@/components/reports/__tests__/fixtures/agent-artifact.json';

describe('toPreviewDashboard', () => {
  it('drops the agent`s auto-refresh so an open preview never re-runs its SQL', () => {
    expect((agentArtifact as { refresh?: string }).refresh).toBe('5m');

    const dashboard = toPreviewDashboard(agentArtifact);

    expect(dashboard).not.toBeNull();
    expect(dashboard?.refresh).toBeUndefined();
    expect('refresh' in (dashboard as object)).toBe(false);
  });

  it('leaves everything the preview is meant to validate untouched', () => {
    const dashboard = toPreviewDashboard(agentArtifact);

    expect(dashboard?.title).toBe(agentArtifact.title);
    expect(dashboard?.panels).toEqual(agentArtifact.panels);
    expect(dashboard?.time).toEqual(agentArtifact.time);
  });

  it('does not mutate the schema that Apply will save', () => {
    const schema = { panels: [{ id: 1 }], refresh: '30s', title: 'T' };
    toPreviewDashboard(schema);
    expect(schema.refresh).toBe('30s');
  });

  it('returns the same object when there is no refresh to drop', () => {
    const schema = { panels: [{ id: 1 }], title: 'T' };
    expect(toPreviewDashboard(schema)).toBe(schema);
  });

  it('accepts the nested {dashboard: {panels}} shape', () => {
    const dashboard = toPreviewDashboard({ dashboard: { panels: [{ id: 1 }], refresh: '1m' } });
    expect(dashboard?.panels).toHaveLength(1);
    expect(dashboard?.refresh).toBeUndefined();
  });

  it('returns null when the schema carries no panels array at all', () => {
    expect(toPreviewDashboard({ title: 'no panels' })).toBeNull();
    expect(toPreviewDashboard(null)).toBeNull();
  });
});

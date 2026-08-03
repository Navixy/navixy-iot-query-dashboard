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

/**
 * A collapsed row keeps its children in `row.panels[]` and out of the top-level list
 * the renderer's query loop walks — so they are saved by Apply having never been
 * executed, under a banner that counted only the panels that were.
 * (!64 review round 6, finding 3)
 */
describe('toPreviewDashboard — collapsed rows', () => {
  const gridPos = (y: number, h = 8) => ({ x: 0, y, w: 12, h });
  const child = (id: number) => ({
    id, type: 'table', title: `P${id}`, gridPos: gridPos(1),
    'x-navixy': { sql: { statement: `SELECT ${id}` } },
  });

  it('hoists a collapsed row`s children into the list that actually gets executed', () => {
    const schema = {
      title: 'T',
      panels: [
        { id: 'r', type: 'row', title: 'Group', gridPos: { x: 0, y: 0, w: 24, h: 1 },
          collapsed: true, panels: [child(10), child(11)] },
      ],
    };

    const dashboard = toPreviewDashboard(schema);

    const ids = dashboard?.panels.map((panel) => panel.id);
    expect(ids).toContain(10);
    expect(ids).toContain(11);
    const row = dashboard?.panels.find((panel) => panel.id === 'r');
    expect(row?.collapsed).toBe(false);
  });

  it('leaves the schema Apply will save exactly as it was', () => {
    // The dashboard is still saved collapsed. What changes is only how much of it
    // this dialog runs.
    const schema = {
      title: 'T',
      panels: [
        { id: 'r', type: 'row', title: 'Group', gridPos: { x: 0, y: 0, w: 24, h: 1 },
          collapsed: true, panels: [child(10)] },
      ],
    };
    const before = JSON.stringify(schema);

    toPreviewDashboard(schema);

    expect(JSON.stringify(schema)).toBe(before);
  });

  it('leaves an expanded row alone', () => {
    const schema = {
      title: 'T',
      panels: [
        { id: 'r', type: 'row', title: 'Group', gridPos: { x: 0, y: 0, w: 24, h: 1 },
          collapsed: false, panels: [] },
        child(10),
      ],
    };

    const dashboard = toPreviewDashboard(schema);

    expect(dashboard?.panels.map((panel) => panel.id)).toEqual(['r', 10]);
  });

  it('cannot address a row with no id, and leaves it collapsed rather than guessing', () => {
    // The counter reports those children as `unverifiable`, which is the honest
    // answer — silently dropping them is what this whole finding is about.
    const schema = {
      title: 'T',
      panels: [
        { type: 'row', title: 'Group', gridPos: { x: 0, y: 0, w: 24, h: 1 },
          collapsed: true, panels: [child(10)] },
      ],
    };

    const dashboard = toPreviewDashboard(schema);

    expect(dashboard?.panels).toHaveLength(1);
    expect(dashboard?.panels[0].collapsed).toBe(true);
  });
});

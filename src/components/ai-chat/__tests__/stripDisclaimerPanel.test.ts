import { describe, expect, it } from 'vitest';
import { prepareSchemaForSave, stripDisclaimerPanel } from '../applyDashboard';
// The same real agent artifact the panel-status counter is pinned against: one live
// build turn, vendored because ai-chat-plan.local/probe/ is git-ignored. Its panel 1
// is the full-width "Attention" disclaimer at y=0.
import agentArtifact from '@/components/reports/__tests__/fixtures/agent-artifact.json';

const disclaimer = (over: Record<string, unknown> = {}) => ({
  id: 1, type: 'text', title: 'Attention', gridPos: { x: 0, y: 0, w: 24, h: 5 }, ...over,
});
const panel = (id: number, y: number, over: Record<string, unknown> = {}) => ({
  id, type: 'table', title: `Panel ${id}`, gridPos: { x: 0, y, w: 12, h: 8 }, ...over,
});

describe('stripDisclaimerPanel', () => {
  it('removes the disclaimer from the real artifact and closes the hole it leaves', () => {
    const before = agentArtifact.panels as Array<{ id: number; gridPos: { y: number } }>;
    expect(before).toHaveLength(3);
    expect(before.map((p) => p.gridPos.y)).toEqual([0, 5, 19]);

    const after = stripDisclaimerPanel(agentArtifact as unknown as Record<string, unknown>);
    const panels = after.panels as Array<{ id: number; gridPos: { y: number } }>;

    expect(panels).toHaveLength(2);
    expect(panels.map((p) => p.id)).toEqual([2, 3]);
    // Each shifted up by the removed panel's h (5).
    expect(panels.map((p) => p.gridPos.y)).toEqual([0, 14]);
  });

  it('does not mutate the schema it was given', () => {
    const schema = { panels: [disclaimer(), panel(2, 5)] };
    stripDisclaimerPanel(schema);
    expect(schema.panels).toHaveLength(2);
    expect(schema.panels[1].gridPos.y).toBe(5);
  });

  it('matches the agent misspelling "Atention" as well as the correct spelling', () => {
    for (const title of ['Atention', 'Attention', 'ATTENTION', ' attention ']) {
      const schema = { panels: [disclaimer({ title }), panel(2, 5)] };
      expect((stripDisclaimerPanel(schema).panels as unknown[])).toHaveLength(1);
    }
  });

  it('leaves the schema alone when any panel is a row', () => {
    const schema = {
      panels: [disclaimer(), { id: 9, type: 'row', title: 'Group', gridPos: { x: 0, y: 5, w: 24, h: 1 } }],
    };
    expect(stripDisclaimerPanel(schema)).toBe(schema);
  });

  it('leaves the schema alone when nothing matches', () => {
    const schema = { panels: [panel(1, 0), panel(2, 8)] };
    expect(stripDisclaimerPanel(schema)).toBe(schema);
  });

  it('leaves the schema alone when two panels match', () => {
    const schema = { panels: [disclaimer(), disclaimer({ id: 2 }), panel(3, 5)] };
    expect(stripDisclaimerPanel(schema)).toBe(schema);
  });

  it('leaves a text panel that is not at the top alone', () => {
    const schema = { panels: [panel(1, 0), disclaimer({ id: 2, gridPos: { x: 0, y: 8, w: 24, h: 5 } })] };
    expect(stripDisclaimerPanel(schema)).toBe(schema);
  });

  it('leaves a narrow text panel alone', () => {
    const schema = { panels: [disclaimer({ gridPos: { x: 0, y: 0, w: 12, h: 5 } }), panel(2, 5)] };
    expect(stripDisclaimerPanel(schema)).toBe(schema);
  });

  it('leaves the schema alone rather than shifting a panel off the top of the canvas', () => {
    // A negative y is off-canvas, unrecoverable in the layout editor, and rejected by
    // the backend validator — better to keep the disclaimer than to break the layout.
    const schema = { panels: [disclaimer(), panel(2, 2)] };
    expect(stripDisclaimerPanel(schema)).toBe(schema);
  });

  it('leaves a schema with no panels array alone', () => {
    const schema = { title: 'No panels here' };
    expect(stripDisclaimerPanel(schema)).toBe(schema);
  });
});

describe('prepareSchemaForSave', () => {
  it('is the identity function with the strip flag off — the saved bytes ARE the previewed bytes', () => {
    const schema = { panels: [disclaimer(), panel(2, 5)] };
    expect(prepareSchemaForSave(schema)).toBe(schema);
    expect(prepareSchemaForSave(agentArtifact as unknown as Record<string, unknown>))
      .toBe(agentArtifact);
  });
});

import { describe, expect, it } from 'vitest';
import { computePanelLoadStatus, type PanelQueryStates } from '../panelLoadStatus';
import type { Panel } from '@/types/dashboard-types';
// A REAL agent artifact, not a hand-written stub: the response of one live
// InvokeAgent build turn, vendored from ai-chat-plan.local/probe/artifact.json
// (which is git-ignored, so it cannot be imported directly). It is the run whose
// barchart failed at execution with `42703 column o.employee_id does not exist`
// while passing every static check — the failure this whole counter exists to
// surface. Its panel 1 is the agent's full-width "Attention" text panel.
import agentArtifact from './fixtures/agent-artifact.json';

const gridPos = { x: 0, y: 0, w: 12, h: 8 };

function sqlPanel(id: string | number, statement = 'SELECT 1'): Panel {
  return { id, type: 'table', title: `Panel ${id}`, gridPos, 'x-navixy': { sql: { statement } } };
}

function state(over: Partial<PanelQueryStates[string]> = {}): PanelQueryStates[string] {
  return { data: null, loading: false, refreshing: false, error: null, ...over };
}

describe('computePanelLoadStatus', () => {
  it('counts nothing for an empty dashboard', () => {
    expect(computePanelLoadStatus([], {})).toEqual({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 0 });
  });

  it('excludes text panels from every count', () => {
    const panels: Panel[] = [
      { id: 't', type: 'text', title: 'Note', gridPos, options: { content: 'hi' } },
      sqlPanel(1),
    ];
    expect(computePanelLoadStatus(panels, { '1': state({ data: { rows: [] } }) }))
      .toEqual({ total: 1, loaded: 1, failed: 0, pending: 0, unverifiable: 0 });
  });

  it('excludes a text panel that carries SQL anyway', () => {
    const panels: Panel[] = [
      { id: 't', type: 'text', title: 'Note', gridPos, 'x-navixy': { sql: { statement: 'SELECT 1' } } },
    ];
    expect(computePanelLoadStatus(panels, {}).total).toBe(0);
  });

  it('does not RUN a panel whose statement is blank, and does not hide it either', () => {
    // The backend validator passes an empty statement as a warning (fixture 05 ships
    // one), and the renderer paints "No SQL configured". Dropping it from every count
    // turned that into "This dashboard has no data panels" — a true sentence about the
    // preview, read as a sentence about the dashboard being saved.
    // (!64 review round 6, finding 3)
    expect(computePanelLoadStatus([sqlPanel(1, '   ')], {}))
      .toEqual({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 1 });
  });

  it('counts a panel with no x-navixy at all the same way', () => {
    const bare: Panel = { id: 1, type: 'kpi', title: 'Count', gridPos };
    expect(computePanelLoadStatus([bare], {}))
      .toEqual({ total: 0, loaded: 0, failed: 0, pending: 0, unverifiable: 1 });
  });

  it('never folds an unverifiable panel into pending, which would never clear', () => {
    // Apply unlocks on `pending === 0`. A panel that is never executed never resolves,
    // so counting it as pending would lock Apply for the life of the card.
    const status = computePanelLoadStatus([sqlPanel(1, ''), sqlPanel(2)], {
      '2': state({ data: { rows: [] } }),
    });
    expect(status).toEqual({ total: 1, loaded: 1, failed: 0, pending: 0, unverifiable: 1 });
  });

  it('counts a COLLAPSED row`s children, which the query loop never reaches', () => {
    // Canonicalization moves a collapsed row's children into `row.panels[]` and out of
    // the top-level list the loop walks. They are still saved by Apply, so a banner
    // that ignored them said "All 1 panels loaded" over two unexecuted statements.
    const row: Panel = {
      id: 'r', type: 'row', title: 'Group', gridPos, collapsed: true,
      panels: [sqlPanel(10), sqlPanel(11), { id: 't', type: 'text', title: 'n', gridPos }],
    };
    expect(computePanelLoadStatus([row, sqlPanel(1)], { '1': state({ data: {} }) }))
      .toEqual({ total: 1, loaded: 1, failed: 0, pending: 0, unverifiable: 2 });
  });

  it('counts an errored panel as failed, never as loaded', () => {
    const panelData: PanelQueryStates = { '1': state({ error: '42703 column o.employee_id does not exist' }) };
    expect(computePanelLoadStatus([sqlPanel(1)], panelData))
      .toEqual({ total: 1, loaded: 0, failed: 1, pending: 0, unverifiable: 0 });
  });

  it('counts a panel holding data while refreshing as pending, not loaded', () => {
    const panelData: PanelQueryStates = { '1': state({ data: { rows: [[1]] }, refreshing: true }) };
    expect(computePanelLoadStatus([sqlPanel(1)], panelData))
      .toEqual({ total: 1, loaded: 0, failed: 0, pending: 1, unverifiable: 0 });
  });

  it('counts a panel holding stale data AND an error as failed', () => {
    // The bulk query loop preserves `data` when a re-run fails, so both fields are
    // set at once. Testing `error` before `data` is what keeps this from counting
    // as loaded — the whole point of the ordering.
    const panelData: PanelQueryStates = { '1': state({ data: { rows: [[1]] }, error: 'Query execution failed' }) };
    expect(computePanelLoadStatus([sqlPanel(1)], panelData))
      .toEqual({ total: 1, loaded: 0, failed: 1, pending: 0, unverifiable: 0 });
  });

  it('counts a loading panel as pending', () => {
    expect(computePanelLoadStatus([sqlPanel(1)], { '1': state({ loading: true }) }))
      .toEqual({ total: 1, loaded: 0, failed: 0, pending: 1, unverifiable: 0 });
  });

  it('counts a panel with no state entry at all as pending', () => {
    expect(computePanelLoadStatus([sqlPanel(1)], {}))
      .toEqual({ total: 1, loaded: 0, failed: 0, pending: 1, unverifiable: 0 });
  });

  it('counts a settled panel with neither data nor error as pending', () => {
    expect(computePanelLoadStatus([sqlPanel(1)], { '1': state() }))
      .toEqual({ total: 1, loaded: 0, failed: 0, pending: 1, unverifiable: 0 });
  });

  it('excludes row HEADERS, which carry no SQL of their own', () => {
    const row: Panel = { id: 'r', type: 'row', title: 'Group', gridPos, collapsed: false };
    expect(computePanelLoadStatus([row, sqlPanel(1)], { '1': state({ data: {} }) }))
      .toEqual({ total: 1, loaded: 1, failed: 0, pending: 0, unverifiable: 0 });
  });

  it('leaves an EXPANDED row alone — its children are already top-level', () => {
    // Canonicalization empties `row.panels` when the row is expanded, so there is
    // nothing to double-count. Pinned because the collapsed case above reads the
    // same field.
    const row: Panel = { id: 'r', type: 'row', title: 'Group', gridPos, collapsed: false, panels: [] };
    expect(computePanelLoadStatus([row, sqlPanel(1)], { '1': state({ data: {} }) }).unverifiable)
      .toBe(0);
  });

  it('keys state by String(panel.id), matching the renderer', () => {
    // The renderer stores under String(panel.id); a numeric id must still find it.
    expect(computePanelLoadStatus([sqlPanel(7)], { '7': state({ data: {} }) }).loaded).toBe(1);
  });

  it('reports the real agent artifact with its failing panel — the R27 regression', () => {
    const panels = agentArtifact.panels as unknown as Panel[];
    // Panel 1 is the "Attention" text panel (excluded); 2 is the barchart whose
    // hallucinated `o.employee_id` fails at execution; 3 is the table that works.
    const panelData: PanelQueryStates = {
      '2': state({ error: 'Query execution failed: column o.employee_id does not exist' }),
      '3': state({ data: { rows: [[1]] } }),
    };
    expect(computePanelLoadStatus(panels, panelData))
      .toEqual({ total: 2, loaded: 1, failed: 1, pending: 0, unverifiable: 0 });
  });
});

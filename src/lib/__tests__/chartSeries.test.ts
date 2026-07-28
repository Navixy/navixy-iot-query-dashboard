import { describe, it, expect } from 'vitest';
import {
  buildLineChartSeries,
  detectSeriesColumnIndex,
  seriesDataKey,
  SERIES_COLUMN_INDEX,
} from '../chartSeries';

const TIME_COLUMNS = [
  { name: 'ts', type: 'timestamptz' },
  { name: 'value', type: 'numeric' },
  { name: 'series', type: 'text' },
];

describe('detectSeriesColumnIndex', () => {
  it('treats a repeating text 3rd column as the series key', () => {
    const rows = [
      ['2026-07-01T10:00:00Z', 1, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 2, 'Sensor B'],
      ['2026-07-01T10:02:00Z', 3, 'Sensor A'],
      ['2026-07-01T10:03:00Z', 4, 'Sensor B'],
    ];
    expect(detectSeriesColumnIndex(TIME_COLUMNS, rows)).toBe(SERIES_COLUMN_INDEX);
  });

  it('keeps a numeric 3rd column as a second metric when x never repeats', () => {
    const columns = [
      { name: 'ts', type: 'timestamptz' },
      { name: 'temp_a', type: 'numeric' },
      { name: 'temp_b', type: 'numeric' },
    ];
    const rows = [
      ['2026-07-01T10:00:00Z', 1, 10],
      ['2026-07-01T10:01:00Z', 2, 11],
      ['2026-07-01T10:02:00Z', 3, 12],
    ];
    expect(detectSeriesColumnIndex(columns, rows)).toBeNull();
  });

  it('returns null for two-column results and for empty results', () => {
    const columns = [{ name: 'ts', type: 'timestamptz' }, { name: 'value', type: 'numeric' }];
    expect(detectSeriesColumnIndex(columns, [['2026-07-01T10:00:00Z', 1]])).toBeNull();
    expect(detectSeriesColumnIndex(TIME_COLUMNS, [])).toBeNull();
  });
});

describe('buildLineChartSeries — long format', () => {
  // DO-273: the reported shape. Each sample belongs to exactly one series, so
  // every series is absent at every other series' x. Those holes are other
  // series' sample times, not gaps in this one — isLongFormat is what tells the
  // panel to join across them. Left as gaps, each series is a run of isolated
  // points, which Recharts draws as zero-length segments: an empty plot area
  // under a legend that names all three groups.
  const rows = [
    ['2026-07-01T10:00:00Z', 10, 'Sensor A'],
    ['2026-07-01T10:01:00Z', 60, 'Sensor B'],
    ['2026-07-01T10:02:00Z', 110, 'Sensor C'],
    ['2026-07-01T10:03:00Z', 13, 'Sensor A'],
  ];

  it('reports the long format so the panel connects across other series samples', () => {
    expect(buildLineChartSeries(TIME_COLUMNS, rows).isLongFormat).toBe(true);
  });

  it('lists every distinct series value, in first-seen order', () => {
    expect(buildLineChartSeries(TIME_COLUMNS, rows).seriesNames).toEqual([
      'Sensor A',
      'Sensor B',
      'Sensor C',
    ]);
  });

  it('pivots one entry per x, carrying only the series sampled there', () => {
    const { xKey, chartData } = buildLineChartSeries(TIME_COLUMNS, rows);
    expect(xKey).toBe('ts');
    expect(chartData).toEqual([
      { ts: '2026-07-01T10:00:00Z', 'Sensor A': 10 },
      { ts: '2026-07-01T10:01:00Z', 'Sensor B': 60 },
      { ts: '2026-07-01T10:02:00Z', 'Sensor C': 110 },
      { ts: '2026-07-01T10:03:00Z', 'Sensor A': 13 },
    ]);
  });

  it('merges series that share an x onto one entry', () => {
    const shared = [
      ['2026-07-01T10:00:00Z', 10, 'Sensor A'],
      ['2026-07-01T10:00:00Z', 60, 'Sensor B'],
      ['2026-07-01T10:01:00Z', 11, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 61, 'Sensor B'],
    ];
    expect(buildLineChartSeries(TIME_COLUMNS, shared).chartData).toEqual([
      { ts: '2026-07-01T10:00:00Z', 'Sensor A': 10, 'Sensor B': 60 },
      { ts: '2026-07-01T10:01:00Z', 'Sensor A': 11, 'Sensor B': 61 },
    ]);
  });

  it('sorts entries chronologically even when the query did not', () => {
    const unordered = [
      ['2026-07-01T10:02:00Z', 3, 'Sensor A'],
      ['2026-07-01T10:00:00Z', 1, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 2, 'Sensor B'],
    ];
    expect(
      buildLineChartSeries(TIME_COLUMNS, unordered).chartData.map(point => point.ts),
    ).toEqual([
      '2026-07-01T10:00:00Z',
      '2026-07-01T10:01:00Z',
      '2026-07-01T10:02:00Z',
    ]);
  });

  it('parses numeric strings and nulls what cannot be plotted', () => {
    // Note the panel then connects across this null as well: pivoted, an
    // explicit NULL reading and "this series did not sample here" are the same
    // absent value. That trade-off is documented on buildLineChartSeries — the
    // alternative was series that do not render at all.
    const mixed = [
      ['2026-07-01T10:00:00Z', '10.5', 'Sensor A'],
      ['2026-07-01T10:01:00Z', null, 'Sensor A'],
    ];
    expect(buildLineChartSeries(TIME_COLUMNS, mixed).chartData).toEqual([
      { ts: '2026-07-01T10:00:00Z', 'Sensor A': 10.5 },
      { ts: '2026-07-01T10:01:00Z', 'Sensor A': null },
    ]);
  });

  it('keeps the x value when a series label collides with the x column name', () => {
    // "ts" as a series label would otherwise land in the x slot and break the
    // axis at every point it appears at.
    const colliding = [
      ['2026-07-01T10:00:00Z', 10, 'ts'],
      ['2026-07-01T10:00:00Z', 60, 'Sensor B'],
      ['2026-07-01T10:01:00Z', 11, 'ts'],
      ['2026-07-01T10:01:00Z', 61, 'Sensor B'],
    ];
    const { chartData, seriesNames } = buildLineChartSeries(TIME_COLUMNS, colliding);
    expect(seriesNames).toEqual(['Sensor B']);
    expect(chartData).toEqual([
      { ts: '2026-07-01T10:00:00Z', 'Sensor B': 60 },
      { ts: '2026-07-01T10:01:00Z', 'Sensor B': 61 },
    ]);
  });
});

describe('buildLineChartSeries — wide format', () => {
  const columns = [
    { name: 'ts', type: 'timestamptz' },
    { name: 'temp_a', type: 'numeric' },
    { name: 'temp_b', type: 'numeric' },
  ];

  it('plots one series per value column and keeps missing values as gaps', () => {
    // Every column shares one x grid here, so a null really is a missing
    // sample: isLongFormat stays false and the panel leaves the gap alone
    // rather than drawing a straight line over it.
    const rows = [
      ['2026-07-01T10:00:00Z', 1, 10],
      ['2026-07-01T10:01:00Z', null, 11],
    ];
    const { seriesNames, chartData, isLongFormat } = buildLineChartSeries(columns, rows);
    expect(isLongFormat).toBe(false);
    expect(seriesNames).toEqual(['temp_a', 'temp_b']);
    expect(chartData).toEqual([
      { ts: '2026-07-01T10:00:00Z', temp_a: 1, temp_b: 10 },
      { ts: '2026-07-01T10:01:00Z', temp_a: null, temp_b: 11 },
    ]);
  });

  it('names unnamed value columns positionally', () => {
    const { seriesNames } = buildLineChartSeries([], [['2026-07-01T10:00:00Z', 1, 2]]);
    expect(seriesNames).toEqual(['value1', 'value2']);
  });

  it('yields no series for a single-column result, so the panel can say so', () => {
    const { seriesNames } = buildLineChartSeries(
      [{ name: 'ts', type: 'timestamptz' }],
      [['2026-07-01T10:00:00Z']],
    );
    expect(seriesNames).toEqual([]);
  });

  it('yields no series for an empty result', () => {
    const { chartData, seriesNames } = buildLineChartSeries(columns, []);
    expect(chartData).toEqual([]);
    expect(seriesNames).toEqual([]);
  });
});

describe('seriesDataKey', () => {
  it('passes plain labels through as string keys', () => {
    expect(seriesDataKey('Sensor A')).toBe('Sensor A');
  });

  it('accesses labels Recharts would read as a nested path via a function', () => {
    // "2.1.0" as a string dataKey would be resolved as row[2][1][0].
    const key = seriesDataKey('2.1.0');
    expect(typeof key).toBe('function');
    expect((key as (row: Record<string, unknown>) => unknown)({ '2.1.0': 42 })).toBe(42);
  });
});

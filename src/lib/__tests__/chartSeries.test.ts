import { describe, it, expect } from 'vitest';
import {
  assignSeriesKeys,
  buildBarChartSeries,
  buildLineChartSeries,
  detectSeriesColumnIndex,
  SERIES_COLUMN_INDEX,
  type BarChartSeries,
  type ChartSeries,
  type LineChartSeries,
} from '../chartSeries';

const TIME_COLUMNS = [
  { name: 'ts', type: 'timestamptz' },
  { name: 'value', type: 'numeric' },
  { name: 'series', type: 'text' },
];

/**
 * Pivoted rows re-keyed by series label. The keys the panel plots are generated
 * (`__series_0`, ...) precisely so no runtime label decides an object key; the
 * label mapping is asserted directly in "keys are generated, never taken from
 * the data" and read back through here everywhere else.
 */
function pointsByLabel(
  axisKey: string,
  chartData: ReadonlyArray<Record<string, unknown>>,
  series: ReadonlyArray<ChartSeries>,
) {
  return chartData.map((point) => {
    const readable: Record<string, unknown> = { x: point[axisKey] };
    for (const { key, label } of series) {
      if (key in point) readable[label] = point[key];
    }
    return readable;
  });
}

const byLabel = ({ xKey, chartData, series }: LineChartSeries) =>
  pointsByLabel(xKey, chartData, series);

const barsByLabel = ({ categoryKey, chartData, series }: BarChartSeries) =>
  pointsByLabel(categoryKey, chartData, series);

const labelsOf = (result: LineChartSeries | BarChartSeries) => result.series.map(s => s.label);

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
    // [ts, avg, sample_count]: the counts repeat as thoroughly as a device id
    // would, and the timestamps are one per row, so only the column name says
    // this is a measurement rather than a grouping key.
    const columns = [
      { name: 'ts', type: 'timestamptz' },
      { name: 'avg_temp', type: 'numeric' },
      { name: 'sample_count', type: 'integer' },
    ];
    const rows = [
      ['2026-07-01T10:00:00Z', 1, 10],
      ['2026-07-01T10:01:00Z', 2, 10],
      ['2026-07-01T10:02:00Z', 3, 11],
    ];
    expect(detectSeriesColumnIndex(columns, rows)).toBeNull();
  });

  it('groups by a numeric id column even when no two series share a timestamp', () => {
    // DO-273 review: sensors that report independently never land on the same
    // timestamp, so the x-repetition signal is absent exactly where grouping
    // matters most. The column name carries it instead.
    const columns = [
      { name: 'ts', type: 'timestamptz' },
      { name: 'value', type: 'numeric' },
      { name: 'device_id', type: 'integer' },
    ];
    const rows = [
      ['2026-07-01T10:00:00Z', 10, 1],
      ['2026-07-01T10:00:30Z', 20, 2],
      ['2026-07-01T10:01:00Z', 11, 1],
      ['2026-07-01T10:01:30Z', 21, 2],
    ];
    expect(detectSeriesColumnIndex(columns, rows)).toBe(SERIES_COLUMN_INDEX);
    expect(labelsOf(buildLineChartSeries(columns, rows))).toEqual(['1', '2']);
  });

  it('accepts the repetition threshold at its boundary', () => {
    // 4 groups over 5 rows: one series sampled twice, three once. Sparse, but
    // long format — an exclusive comparison rejected it (4 < 5 * 0.8 is false).
    const rows = [
      ['2026-07-01T10:00:00Z', 1, 'A'],
      ['2026-07-01T10:01:00Z', 2, 'B'],
      ['2026-07-01T10:02:00Z', 3, 'C'],
      ['2026-07-01T10:03:00Z', 4, 'D'],
      ['2026-07-01T10:04:00Z', 5, 'A'],
    ];
    expect(detectSeriesColumnIndex(TIME_COLUMNS, rows)).toBe(SERIES_COLUMN_INDEX);
  });

  it('returns null for two-column results and for empty results', () => {
    const columns = [{ name: 'ts', type: 'timestamptz' }, { name: 'value', type: 'numeric' }];
    expect(detectSeriesColumnIndex(columns, [['2026-07-01T10:00:00Z', 1]])).toBeNull();
    expect(detectSeriesColumnIndex(TIME_COLUMNS, [])).toBeNull();
  });
});

describe('detectSeriesColumnIndex — explicit seriesColumn', () => {
  const columns = [
    { name: 'ts', type: 'timestamptz' },
    { name: 'value', type: 'numeric' },
    { name: 'firmware', type: 'numeric' },
  ];
  // Detection says wide here: a numeric 3rd column, one row per timestamp, and
  // a name that reads like a metric.
  const rows = [
    ['2026-07-01T10:00:00Z', 10, 2],
    ['2026-07-01T10:00:30Z', 20, 3],
    ['2026-07-01T10:01:00Z', 11, 2],
    ['2026-07-01T10:01:30Z', 21, 3],
  ];

  it('groups by a named column the detector would have skipped', () => {
    expect(detectSeriesColumnIndex(columns, rows, 'firmware')).toBe(SERIES_COLUMN_INDEX);
    expect(labelsOf(buildLineChartSeries(columns, rows, 'firmware'))).toEqual(['2', '3']);
  });

  it('matches a column name case-insensitively and by index', () => {
    expect(detectSeriesColumnIndex(columns, rows, 'Firmware')).toBe(SERIES_COLUMN_INDEX);
    expect(detectSeriesColumnIndex(columns, rows, 2)).toBe(SERIES_COLUMN_INDEX);
  });

  it('plots every value column when set to "none"', () => {
    const grouped = [
      ['2026-07-01T10:00:00Z', 1, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 2, 'Sensor B'],
      ['2026-07-01T10:02:00Z', 3, 'Sensor A'],
      ['2026-07-01T10:03:00Z', 4, 'Sensor B'],
    ];
    expect(detectSeriesColumnIndex(TIME_COLUMNS, grouped, 'none')).toBeNull();
    expect(labelsOf(buildLineChartSeries(TIME_COLUMNS, grouped, 'none')))
      .toEqual(['value', 'series']);
  });

  it('detects when set to "auto", the word the editor stores', () => {
    // Not the same as an absent setting by accident: the panel editor has to be
    // able to *store* "detect", because saving a panel merges its config over
    // the stored one key by key — an override cleared by removing the key would
    // come back from the old config on the very next save.
    const grouped = [
      ['2026-07-01T10:00:00Z', 1, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 2, 'Sensor B'],
      ['2026-07-01T10:02:00Z', 3, 'Sensor A'],
      ['2026-07-01T10:03:00Z', 4, 'Sensor B'],
    ];
    expect(detectSeriesColumnIndex(TIME_COLUMNS, grouped, 'auto')).toBe(SERIES_COLUMN_INDEX);
    expect(detectSeriesColumnIndex(TIME_COLUMNS, grouped, 'Auto')).toBe(SERIES_COLUMN_INDEX);
    // And on data detection reads as wide, "auto" leaves it wide.
    expect(detectSeriesColumnIndex(columns, rows, 'auto')).toBeNull();
  });

  it('falls back to detection when the setting names no usable column', () => {
    // A typo in hand-written dashboard JSON degrades to the heuristic instead
    // of blanking the panel. Index 0/1 are the x and value columns.
    const grouped = [
      ['2026-07-01T10:00:00Z', 1, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 2, 'Sensor B'],
      ['2026-07-01T10:02:00Z', 3, 'Sensor A'],
      ['2026-07-01T10:03:00Z', 4, 'Sensor B'],
    ];
    expect(detectSeriesColumnIndex(TIME_COLUMNS, grouped, 'sensor')).toBe(SERIES_COLUMN_INDEX);
    expect(detectSeriesColumnIndex(TIME_COLUMNS, grouped, 99)).toBe(SERIES_COLUMN_INDEX);
    expect(detectSeriesColumnIndex(TIME_COLUMNS, grouped, 1)).toBe(SERIES_COLUMN_INDEX);
    expect(detectSeriesColumnIndex(columns, rows, 'nope')).toBeNull();
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
    expect(labelsOf(buildLineChartSeries(TIME_COLUMNS, rows))).toEqual([
      'Sensor A',
      'Sensor B',
      'Sensor C',
    ]);
  });

  it('pivots one entry per x, carrying only the series sampled there', () => {
    expect(byLabel(buildLineChartSeries(TIME_COLUMNS, rows))).toEqual([
      { x: '2026-07-01T10:00:00Z', 'Sensor A': 10 },
      { x: '2026-07-01T10:01:00Z', 'Sensor B': 60 },
      { x: '2026-07-01T10:02:00Z', 'Sensor C': 110 },
      { x: '2026-07-01T10:03:00Z', 'Sensor A': 13 },
    ]);
  });

  it('merges series that share an x onto one entry', () => {
    const shared = [
      ['2026-07-01T10:00:00Z', 10, 'Sensor A'],
      ['2026-07-01T10:00:00Z', 60, 'Sensor B'],
      ['2026-07-01T10:01:00Z', 11, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 61, 'Sensor B'],
    ];
    expect(byLabel(buildLineChartSeries(TIME_COLUMNS, shared))).toEqual([
      { x: '2026-07-01T10:00:00Z', 'Sensor A': 10, 'Sensor B': 60 },
      { x: '2026-07-01T10:01:00Z', 'Sensor A': 11, 'Sensor B': 61 },
    ]);
  });

  it('sorts entries chronologically even when the query did not', () => {
    const unordered = [
      ['2026-07-01T10:02:00Z', 3, 'Sensor A'],
      ['2026-07-01T10:00:00Z', 1, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 2, 'Sensor B'],
    ];
    expect(byLabel(buildLineChartSeries(TIME_COLUMNS, unordered)).map(p => p.x)).toEqual([
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
    expect(byLabel(buildLineChartSeries(TIME_COLUMNS, mixed))).toEqual([
      { x: '2026-07-01T10:00:00Z', 'Sensor A': 10.5 },
      { x: '2026-07-01T10:01:00Z', 'Sensor A': null },
    ]);
  });
});

describe('buildLineChartSeries — labels the data chose', () => {
  // A series label is a value out of the database: it can equal the x column's
  // name, be "__proto__", or contain the "." Recharts reads as a nested path.
  // None of those may cost the series its values or its legend entry.
  it('keys are generated, never taken from the data', () => {
    const rows = [
      ['2026-07-01T10:00:00Z', 10, 'Sensor A'],
      ['2026-07-01T10:00:00Z', 60, 'Sensor B'],
      ['2026-07-01T10:01:00Z', 11, 'Sensor A'],
      ['2026-07-01T10:01:00Z', 61, 'Sensor B'],
    ];
    const { xKey, chartData, series } = buildLineChartSeries(TIME_COLUMNS, rows);
    expect(series).toEqual([
      { key: '__series_0', label: 'Sensor A' },
      { key: '__series_1', label: 'Sensor B' },
    ]);
    expect(chartData).toEqual([
      { [xKey]: '2026-07-01T10:00:00Z', __series_0: 10, __series_1: 60 },
      { [xKey]: '2026-07-01T10:01:00Z', __series_0: 11, __series_1: 61 },
    ]);
    expect(xKey).not.toBe('__series_0');
  });

  it('keeps a series whose label is the x column name, and the x value', () => {
    const colliding = [
      ['2026-07-01T10:00:00Z', 10, 'ts'],
      ['2026-07-01T10:00:00Z', 60, 'Sensor B'],
      ['2026-07-01T10:01:00Z', 11, 'ts'],
      ['2026-07-01T10:01:00Z', 61, 'Sensor B'],
    ];
    const result = buildLineChartSeries(TIME_COLUMNS, colliding);
    expect(labelsOf(result)).toEqual(['ts', 'Sensor B']);
    expect(byLabel(result)).toEqual([
      { x: '2026-07-01T10:00:00Z', ts: 10, 'Sensor B': 60 },
      { x: '2026-07-01T10:01:00Z', ts: 11, 'Sensor B': 61 },
    ]);
  });

  it('keeps a series labelled "__proto__" as ordinary data', () => {
    // Assigned under its own name it would set the row's prototype instead of
    // a property, and the series would plot nothing.
    const rows = [
      ['2026-07-01T10:00:00Z', 10, '__proto__'],
      ['2026-07-01T10:00:00Z', 60, 'Sensor B'],
      ['2026-07-01T10:01:00Z', 11, '__proto__'],
      ['2026-07-01T10:01:00Z', 61, 'Sensor B'],
    ];
    const result = buildLineChartSeries(TIME_COLUMNS, rows);
    expect(labelsOf(result)).toEqual(['__proto__', 'Sensor B']);
    const [first] = result.chartData;
    expect(Object.prototype.hasOwnProperty.call(first, result.series[0].key)).toBe(true);
    expect(first[result.series[0].key]).toBe(10);
  });

  it('keeps a series whose label Recharts would read as a nested path', () => {
    // "2.1.0" as a string dataKey resolves as row[2][1][0] and renders nothing.
    const rows = [
      ['2026-07-01T10:00:00Z', 10, '2.1.0'],
      ['2026-07-01T10:00:00Z', 60, '2.2.0'],
      ['2026-07-01T10:01:00Z', 11, '2.1.0'],
      ['2026-07-01T10:01:00Z', 61, '2.2.0'],
    ];
    const result = buildLineChartSeries(TIME_COLUMNS, rows);
    expect(labelsOf(result)).toEqual(['2.1.0', '2.2.0']);
    expect(result.series.every(s => !/[.[\]]/.test(s.key))).toBe(true);
    expect(byLabel(result)[0]).toEqual({
      x: '2026-07-01T10:00:00Z', '2.1.0': 10, '2.2.0': 60,
    });
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
    const result = buildLineChartSeries(columns, rows);
    expect(result.isLongFormat).toBe(false);
    expect(labelsOf(result)).toEqual(['temp_a', 'temp_b']);
    expect(byLabel(result)).toEqual([
      { x: '2026-07-01T10:00:00Z', temp_a: 1, temp_b: 10 },
      { x: '2026-07-01T10:01:00Z', temp_a: null, temp_b: 11 },
    ]);
  });

  it('keeps two same-named columns as two series', () => {
    // `SELECT a.ts, a.value, b.value` — the second column would otherwise
    // overwrite the first and lose a line.
    const duplicate = [
      { name: 'ts', type: 'timestamptz' },
      { name: 'value', type: 'numeric' },
      { name: 'value', type: 'numeric' },
    ];
    const result = buildLineChartSeries(duplicate, [['2026-07-01T10:00:00Z', 1, 2]]);
    expect(labelsOf(result)).toEqual(['value', 'value']);
    expect(result.chartData[0][result.series[0].key]).toBe(1);
    expect(result.chartData[0][result.series[1].key]).toBe(2);
  });

  it('names unnamed value columns positionally', () => {
    expect(labelsOf(buildLineChartSeries([], [['2026-07-01T10:00:00Z', 1, 2]])))
      .toEqual(['value1', 'value2']);
  });

  it('yields no series for a single-column result, so the panel can say so', () => {
    const result = buildLineChartSeries(
      [{ name: 'ts', type: 'timestamptz' }],
      [['2026-07-01T10:00:00Z']],
    );
    expect(result.series).toEqual([]);
  });

  it('yields no series for an empty result', () => {
    const result = buildLineChartSeries(columns, []);
    expect(result.chartData).toEqual([]);
    expect(result.series).toEqual([]);
  });
});

describe('buildBarChartSeries', () => {
  const METRIC_COLUMNS = [
    { name: 'region', type: 'text' },
    { name: 'metric_a', type: 'numeric' },
    { name: 'metric_b', type: 'numeric' },
  ];
  const METRIC_ROWS = [
    ['North', 10, 1],
    ['South', 20, 2],
  ];

  it('plots every value column when set to "none"', () => {
    // The contract seriesColumn: 'none' states — one series per value column.
    // Bars used to read column 2 alone, so metric_b vanished from the chart
    // that had explicitly asked for it.
    const result = buildBarChartSeries(METRIC_COLUMNS, METRIC_ROWS, 'none');

    expect(labelsOf(result)).toEqual(['metric_a', 'metric_b']);
    expect(barsByLabel(result)).toEqual([
      { x: 'North', metric_a: 10, metric_b: 1 },
      { x: 'South', metric_a: 20, metric_b: 2 },
    ]);
    expect(result.isGrouped).toBe(false);
  });

  it('plots every value column the detector reads as wide, with no override', () => {
    // The same loss without anyone asking for it: [category, avg, count] is
    // wide by detection, and the count column was dropped on the floor.
    const result = buildBarChartSeries(
      [
        { name: 'region', type: 'text' },
        { name: 'avg_speed', type: 'numeric' },
        { name: 'sample_count', type: 'integer' },
      ],
      [['North', 42, 7], ['South', 51, 9]],
    );

    expect(labelsOf(result)).toEqual(['avg_speed', 'sample_count']);
    expect(barsByLabel(result)).toEqual([
      { x: 'North', avg_speed: 42, sample_count: 7 },
      { x: 'South', avg_speed: 51, sample_count: 9 },
    ]);
  });

  it('keeps a two-column result a single unnamed-in-legend series', () => {
    const result = buildBarChartSeries(
      [{ name: 'region', type: 'text' }, { name: 'total', type: 'integer' }],
      [['North', 10], ['South', 20]],
    );

    expect(result.series).toHaveLength(1);
    // Not grouped and alone: what the panel reads to keep the plain-total look
    // (no legend, the panel's own title in the tooltip).
    expect(result.isGrouped).toBe(false);
    expect(barsByLabel(result)).toEqual([
      { x: 'North', total: 10 },
      { x: 'South', total: 20 },
    ]);
  });

  it('merges rows of a grouped result into one entry per category', () => {
    const result = buildBarChartSeries(
      [
        { name: 'region', type: 'text' },
        { name: 'total', type: 'integer' },
        { name: 'vehicle', type: 'text' },
      ],
      [
        ['North', 10, 'Truck'],
        ['North', 4, 'Van'],
        ['South', 20, 'Truck'],
      ],
    );

    expect(result.isGrouped).toBe(true);
    // South has no Van row: a bar chart draws that as a zero-height bar, not as
    // a hole, so every series has a slot in every category.
    expect(barsByLabel(result)).toEqual([
      { x: 'North', Truck: 10, Van: 4 },
      { x: 'South', Truck: 20, Van: 0 },
    ]);
  });

  it('keeps a group labelled "__proto__" as ordinary data', () => {
    const result = buildBarChartSeries(
      [
        { name: 'region', type: 'text' },
        { name: 'total', type: 'integer' },
        { name: 'vehicle', type: 'text' },
      ],
      [
        ['North', 10, '__proto__'],
        ['North', 4, 'Van'],
        ['South', 20, '__proto__'],
        ['South', 6, 'Van'],
      ],
    );

    // Asserted key by key rather than through barsByLabel: `__proto__` in an
    // object literal is prototype syntax, so an expectation written that way
    // would compare two objects that both silently dropped it.
    expect(labelsOf(result)).toEqual(['__proto__', 'Van']);
    const protoKey = result.series[0].key;
    expect(result.chartData.map(item => [
      item[result.categoryKey],
      Object.prototype.hasOwnProperty.call(item, protoKey),
      item[protoKey],
    ])).toEqual([
      ['North', true, 10],
      ['South', true, 20],
    ]);
  });

  it('reads a non-numeric bar height as zero', () => {
    // A bar is a height; there is no gap to leave, unlike a line.
    const result = buildBarChartSeries(
      [{ name: 'region', type: 'text' }, { name: 'total', type: 'integer' }],
      [['North', null], ['South', 'n/a'], ['East', '20']],
    );

    expect(barsByLabel(result)).toEqual([
      { x: 'North', total: 0 },
      { x: 'South', total: 0 },
      { x: 'East', total: 20 },
    ]);
  });
});

describe('assignSeriesKeys', () => {
  it('gives each distinct label one key, in first-seen order', () => {
    expect(assignSeriesKeys(['B', 'A', 'B'])).toEqual([
      { key: '__series_0', label: 'B' },
      { key: '__series_1', label: 'A' },
    ]);
  });
});

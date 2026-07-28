/**
 * Shared series-shape detection for chart panels (DO-273).
 *
 * Query results arrive in one of two shapes:
 *   • Long format  [x, value, series]       -> one series per distinct col-3 value
 *   • Wide format  [x, value1, value2, ...]  -> one series per value column
 *
 * Bar and line/time-series panels both call detectSeriesColumnIndex so the same
 * query groups identically everywhere, instead of each panel re-deriving (and
 * drifting on) its own heuristic.
 */

/**
 * Fraction of distinct col-3 values below which the column is treated as a
 * grouping key rather than per-row identifiers. Shared by every panel so tuning
 * it can't silently change one chart type and not another.
 */
export const LONG_FORMAT_REPETITION_THRESHOLD = 0.8;

/** Index of the series-label column in long format ([x, value, series]). */
export const SERIES_COLUMN_INDEX = 2;

// Numeric column types, matched exactly (lower-cased). An exact set avoids
// substring false positives such as "interval" or "point" (both contain "int")
// being mistaken for numbers.
const NUMERIC_COLUMN_TYPES = new Set([
  'number', 'integer', 'int', 'int2', 'int4', 'int8', 'smallint', 'bigint',
  'numeric', 'decimal', 'real', 'double precision', 'float', 'float4', 'float8',
  'money', 'serial', 'bigserial', 'smallserial',
]);

interface ColumnMeta {
  name?: string;
  type?: string;
}

/**
 * Decide whether the result describes long format with a series-grouping column
 * at index 2. Returns SERIES_COLUMN_INDEX when it does, otherwise null (wide or
 * simple two-column data).
 *
 * A numeric 3rd column is treated as a grouping key only when the x-axis (col 1)
 * repeats — i.e. each series contributes a row per x. Without repeated x it is a
 * second metric (wide format), so numeric metrics aren't mistaken for groupings.
 */
export function detectSeriesColumnIndex(
  columns: ReadonlyArray<ColumnMeta>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): number | null {
  if (columns.length <= SERIES_COLUMN_INDEX || rows.length === 0) {
    return null;
  }

  const seriesType = String(columns[SERIES_COLUMN_INDEX]?.type || '').toLowerCase();
  const isNumericSeries = NUMERIC_COLUMN_TYPES.has(seriesType);

  // Single pass over rows: distinct series values and distinct x values.
  const distinctSeries = new Set<string>();
  const distinctX = new Set<string>();
  for (const row of rows) {
    distinctSeries.add(String(row[SERIES_COLUMN_INDEX]));
    distinctX.add(String(row[0]));
  }

  const seriesRepeats = distinctSeries.size < rows.length * LONG_FORMAT_REPETITION_THRESHOLD;
  const xHasDuplicates = distinctX.size < rows.length;

  return seriesRepeats && (!isNumericSeries || xHasDuplicates) ? SERIES_COLUMN_INDEX : null;
}

/** A line / time-series panel's plot-ready data. */
export interface LineChartSeries {
  /** The key holding the x value in every {@link chartData} entry. */
  xKey: string;
  /** One entry per distinct x, carrying every series that has a value there. */
  chartData: Array<Record<string, unknown>>;
  /** The series to plot, in the order that also assigns their colours. */
  seriesNames: string[];
  /**
   * True when the series came from a col-3 grouping key (long format) rather
   * than from separate value columns (wide format). Callers connect across
   * missing points only in long format — see {@link buildLineChartSeries}.
   */
  isLongFormat: boolean;
}

/** Parse a cell into a plottable number, or null when it is not one. */
function toPlottableNumber(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(value) ? value : null;
}

/**
 * Chronological where the x values parse as dates, lexicographic otherwise, in
 * a new array.
 *
 * Each x is parsed once rather than twice per comparison: these panels plot
 * high-cardinality time axes — a day of 10-second samples is ~8.6k points —
 * where a comparator that built two Dates per call would allocate hundreds of
 * thousands of them per render.
 */
function sortByX(
  points: Array<Record<string, unknown>>,
  xKey: string,
): Array<Record<string, unknown>> {
  const keyed = points.map((point) => {
    const raw = point[xKey] as string | number;
    const time = new Date(raw).getTime();
    return { point, raw, time: Number.isNaN(time) ? null : time };
  });
  // Array.prototype.sort is stable, so points that compare equal keep the
  // order the query returned them in.
  keyed.sort((a, b) => {
    if (a.time !== null && b.time !== null) return a.time - b.time;
    return a.raw > b.raw ? 1 : a.raw < b.raw ? -1 : 0;
  });
  return keyed.map((entry) => entry.point);
}

/**
 * Pivot a query result into Recharts rows plus the series to plot (DO-273).
 *
 * Long format ([x, value, series]) groups by the series column, so the x axis
 * becomes the union of every series' x values and a series carries a value only
 * where it actually sampled. Those holes are *not* gaps in the data — they are
 * another series' sample times — which is why {@link isLongFormat} comes back
 * with the data: rendered as gaps, series whose sample times rarely coincide
 * become runs of isolated points, and Recharts draws an isolated point as a
 * zero-length segment — invisible unless dots are on. That is the reported
 * symptom: the legend names every group while the plot area stays empty.
 *
 * Connecting costs something the pivot cannot give back: once every series
 * shares one row array, "absent because another series sampled here" and
 * "explicit NULL reading" are both just null, so a real outage inside a grouped
 * series is drawn straight through. Telling them apart needs a `data` array per
 * series on each Line plus `allowDuplicatedCategory={false}` on the axis — more
 * than the invisible-series bug warranted, and strictly better than the series
 * not being drawn at all.
 *
 * Wide format ([x, value1, value2, ...]) plots one line per value column. There
 * every column shares one x grid, so a missing value really is a gap and stays
 * one.
 */
export function buildLineChartSeries(
  columns: ReadonlyArray<ColumnMeta>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): LineChartSeries {
  const xKey = columns[0]?.name || 'x';
  const seriesColumnIndex = detectSeriesColumnIndex(columns, rows);

  if (seriesColumnIndex !== null) {
    // A series label that happens to equal the x column's name would take the
    // x value's slot in the pivoted row and break the axis for every point it
    // appears at. Drop it instead, the way the wide branch keeps xKey out of
    // its series list.
    const seriesNames = Array.from(
      new Set(rows.map((row) => String(row[seriesColumnIndex]))),
    ).filter((name) => name !== xKey);
    const byX = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const xId = String(row[0]);
      let point = byX.get(xId);
      if (!point) {
        point = { [xKey]: row[0] };
        byX.set(xId, point);
      }
      const seriesKey = String(row[seriesColumnIndex]);
      if (seriesKey !== xKey) point[seriesKey] = toPlottableNumber(row[1]);
    }
    return {
      xKey,
      chartData: sortByX(Array.from(byX.values()), xKey),
      seriesNames,
      isLongFormat: true,
    };
  }

  const chartData = rows.map((row) => {
    const point: Record<string, unknown> = { [xKey]: row[0] };
    if (columns.length > 0) {
      for (let i = 1; i < row.length && i < columns.length; i++) {
        point[columns[i]?.name || `series${ i }`] = toPlottableNumber(row[i]);
      }
    } else {
      for (let i = 1; i < row.length; i++) {
        point[`value${ i }`] = toPlottableNumber(row[i]);
      }
    }
    return point;
  });

  return {
    xKey,
    chartData: sortByX(chartData, xKey),
    // A wide result can have no value columns at all (a single-column query),
    // which leaves nothing to plot; the long branch always yields >= 1 series
    // for non-empty rows.
    seriesNames:
      chartData.length > 0
        ? Object.keys(chartData[0]).filter((key) => key !== xKey)
        : [],
    isLongFormat: false,
  };
}

/**
 * Build a Recharts `dataKey` for a series whose key is a runtime value (a series
 * label) or a column name. Recharts resolves string dataKeys with lodash `get`,
 * so a name containing "." or "[]" (e.g. a firmware label "2.1.0") would be read
 * as a nested path and render nothing. Use a function accessor only for such
 * names; plain strings keep Recharts' per-cell memoization for the common case.
 */
export function seriesDataKey(
  name: string,
): string | ((row: Record<string, unknown>) => unknown) {
  return /[.[\]]/.test(name) ? (row) => row[name] : name;
}

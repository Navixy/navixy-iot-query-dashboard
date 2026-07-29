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
 * Fraction of distinct col-3 values at or below which the column is treated as
 * a grouping key rather than per-row identifiers. Shared by every panel so
 * tuning it can't silently change one chart type and not another.
 *
 * The comparison is inclusive: 4 groups across 5 rows is one series sampling
 * twice while three sample once — sparse long format, which is exactly the
 * shape this ticket is about — and an exclusive `<` sent that to wide format.
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

// Names a numeric column carries when it identifies *what* was measured rather
// than a measurement: device_id, object_label, sensor, series, group. Matched
// on whole trailing words so "unit_count" or "id_error_total" stay metrics.
const GROUPING_COLUMN_NAME_RE =
  /(^|_)(id|uuid|key|code|name|label|title|type|kind|group|series|category|class|sensor|device|object|tracker|vehicle|unit|channel|source)s?$/i;

interface ColumnMeta {
  name?: string;
  type?: string;
}

/**
 * Panel-level override for which column groups the result (DO-273).
 *
 * A column name or a column index (>= 2 — index 0 is the x axis and index 1 the
 * value), or one of two reserved words: `'none'` to plot the result as wide
 * format, `'auto'` to detect the shape from the data. Anything that does not
 * resolve to a real column falls back to the heuristic, so a typo in
 * hand-edited dashboard JSON degrades to the old behaviour instead of blanking
 * the panel.
 *
 * A column actually named `auto` or `none` can only be selected by its index —
 * the reserved words win. Both are written by the panel editor rather than
 * being merely tolerated: `'auto'` has to be a value one can *store*, because
 * the panel save merges the editor's config over the old one key by key, so an
 * override cleared by removing the key would come straight back.
 */
export type SeriesColumnSetting = string | number;

type ResolvedSetting = number | 'none' | 'auto';

function resolveSeriesColumnSetting(
  columns: ReadonlyArray<ColumnMeta>,
  setting: SeriesColumnSetting | undefined,
): ResolvedSetting {
  if (setting === undefined || setting === null) return 'auto';
  if (typeof setting === 'number') {
    return Number.isInteger(setting)
      && setting >= SERIES_COLUMN_INDEX
      && setting < columns.length
      ? setting
      : 'auto';
  }
  if (typeof setting !== 'string') return 'auto';
  const trimmed = setting.trim();
  if (trimmed.length === 0) return 'auto';
  const reserved = trimmed.toLowerCase();
  if (reserved === 'none') return 'none';
  if (reserved === 'auto') return 'auto';
  const exact = columns.findIndex((column) => column?.name === trimmed);
  const index = exact === -1
    // Unquoted identifiers come back from Postgres lower-cased, so a config
    // written as "Device_id" should still find the "device_id" column.
    ? columns.findIndex(
      (column) => column?.name?.toLowerCase() === trimmed.toLowerCase(),
    )
    : exact;
  return index >= SERIES_COLUMN_INDEX ? index : 'auto';
}

/**
 * Decide which column groups the result into series, or null for wide / simple
 * two-column data.
 *
 * `seriesColumn` (from the panel's visualization config) wins when it names a
 * real column: the shapes below are genuinely ambiguous, so a dashboard author
 * needs a way to say which one they meant. Everything else is heuristic.
 *
 * A numeric 3rd column is treated as a grouping key when the x-axis (col 1)
 * repeats — each series contributing a row per x — or when its *name* reads as
 * an identifier (`device_id`, `object_label`). Without either signal it is
 * taken for a second metric (wide format): `[ts, avg, sample_count]` repeats
 * its counts as thoroughly as a device id repeats, and only the name and the
 * x-axis tell the two apart. Series that sample at different times — the case
 * this ticket is about — never repeat an x, which is why the name matters.
 */
export function detectSeriesColumnIndex(
  columns: ReadonlyArray<ColumnMeta>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  seriesColumn?: SeriesColumnSetting,
): number | null {
  if (rows.length === 0) return null;

  const setting = resolveSeriesColumnSetting(columns, seriesColumn);
  if (setting === 'none') return null;
  if (setting !== 'auto') return setting;

  if (columns.length <= SERIES_COLUMN_INDEX) {
    return null;
  }

  const seriesColumnMeta = columns[SERIES_COLUMN_INDEX];
  const seriesType = String(seriesColumnMeta?.type || '').toLowerCase();
  const isNumericSeries = NUMERIC_COLUMN_TYPES.has(seriesType);

  // Single pass over rows: distinct series values and distinct x values.
  const distinctSeries = new Set<string>();
  const distinctX = new Set<string>();
  for (const row of rows) {
    distinctSeries.add(String(row[SERIES_COLUMN_INDEX]));
    distinctX.add(String(row[0]));
  }

  const seriesRepeats = distinctSeries.size <= rows.length * LONG_FORMAT_REPETITION_THRESHOLD;
  const xHasDuplicates = distinctX.size < rows.length;
  const namedLikeGrouping = GROUPING_COLUMN_NAME_RE.test(seriesColumnMeta?.name || '');

  return seriesRepeats && (!isNumericSeries || xHasDuplicates || namedLikeGrouping)
    ? SERIES_COLUMN_INDEX
    : null;
}

/** One plotted series: where its values live, and what to call it. */
export interface ChartSeries {
  /** The key its value is stored under in every pivoted row. */
  key: string;
  /** Name for the legend and tooltip; its position also fixes the colour. */
  label: string;
}

/** A line / time-series panel's plot-ready data. */
export interface LineChartSeries {
  /** The key holding the x value in every {@link chartData} entry. */
  xKey: string;
  /** One entry per distinct x, carrying every series that has a value there. */
  chartData: Array<Record<string, unknown>>;
  /** The series to plot, in the order that also assigns their colours. */
  series: ChartSeries[];
  /**
   * True when the series came from a col-3 grouping key (long format) rather
   * than from separate value columns (wide format). Callers connect across
   * missing points only in long format — see {@link buildLineChartSeries}.
   */
  isLongFormat: boolean;
}

/**
 * The key holding the x value in a pivoted row. Generated, like the series
 * keys, so it cannot collide with a runtime label — see {@link assignSeriesKeys}.
 */
const X_KEY = '__x';

const seriesKeyAt = (index: number): string => `__series_${ index }`;

/**
 * Give each distinct label, in first-seen order, a key to store its values
 * under.
 *
 * The keys are generated rather than taken from the data because a pivoted row
 * is an object and a series label is a runtime value: `"__proto__"` never
 * becomes an own property (the series would silently vanish), a label equal to
 * the x column's name would overwrite the x value, two columns can share a
 * name, and Recharts resolves a string `dataKey` as a lodash path, so a label
 * like a firmware `"2.1.0"` would be read as `row[2][1][0]`. Every key here is
 * `__series_N`, and the label travels separately to the legend via the series
 * element's `name` prop.
 */
export function assignSeriesKeys(labels: Iterable<string>): ChartSeries[] {
  const series: ChartSeries[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    series.push({ key: seriesKeyAt(series.length), label });
  }
  return series;
}

/**
 * Parse a cell into a bar's height. A bar has no way to draw "no value" — it is
 * a height, and an unreadable one is no bar — so anything non-numeric is zero,
 * where a line leaves a gap ({@link toPlottableNumber}).
 */
function toBarNumber(raw: unknown): number {
  return Number(raw) || 0;
}

/** Parse a cell into a plottable number, or null when it is not one. */
function toPlottableNumber(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(value) ? value : null;
}

/**
 * The label for each value column — every column but the first, which is the
 * x axis / category. When the result carries no column metadata the width comes
 * from the rows, the only thing left to read it from.
 */
function valueColumnLabels(
  columns: ReadonlyArray<ColumnMeta>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string[] {
  const labels: string[] = [];
  if (columns.length > 0) {
    for (let i = 1; i < columns.length; i++) {
      labels.push(columns[i]?.name || `series${ i }`);
    }
  } else {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    for (let i = 1; i < width; i++) {
      labels.push(`value${ i }`);
    }
  }
  return labels;
}

/**
 * One series per value column, for a result that is not grouped by a series
 * column.
 *
 * Keyed positionally rather than through {@link assignSeriesKeys}: here a
 * series *is* a column, so two columns that share a name (`SELECT a.ts, b.ts`)
 * are still two series, and de-duplicating the labels would shift every value
 * after them into the wrong series.
 *
 * A wide result can have no value columns at all (a single-column query, or no
 * rows to read a width from), which leaves nothing to plot; the grouped branch
 * always yields >= 1 series for non-empty rows.
 */
function wideFormatSeries(
  columns: ReadonlyArray<ColumnMeta>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): ChartSeries[] {
  if (rows.length === 0) return [];
  return valueColumnLabels(columns, rows).map((label, index) => ({
    key: seriesKeyAt(index),
    label,
  }));
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
): Array<Record<string, unknown>> {
  const keyed = points.map((point) => {
    const raw = point[X_KEY] as string | number;
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
  seriesColumn?: SeriesColumnSetting,
): LineChartSeries {
  const seriesColumnIndex = detectSeriesColumnIndex(columns, rows, seriesColumn);

  if (seriesColumnIndex !== null) {
    const series = assignSeriesKeys(
      rows.map((row) => String(row[seriesColumnIndex])),
    );
    const keyByLabel = new Map(series.map(({ key, label }) => [label, key]));
    const byX = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const xId = String(row[0]);
      let point = byX.get(xId);
      if (!point) {
        point = { [X_KEY]: row[0] };
        byX.set(xId, point);
      }
      point[keyByLabel.get(String(row[seriesColumnIndex]))!] = toPlottableNumber(row[1]);
    }
    return {
      xKey: X_KEY,
      chartData: sortByX(Array.from(byX.values())),
      series,
      isLongFormat: true,
    };
  }

  const series = wideFormatSeries(columns, rows);

  const chartData = rows.map((row) => {
    const point: Record<string, unknown> = { [X_KEY]: row[0] };
    series.forEach(({ key }, index) => {
      point[key] = toPlottableNumber(row[index + 1]);
    });
    return point;
  });

  return {
    xKey: X_KEY,
    chartData: sortByX(chartData),
    series,
    isLongFormat: false,
  };
}

/** A bar panel's plot-ready data. */
export interface BarChartSeries {
  /** The key holding the category in every {@link chartData} entry. */
  categoryKey: string;
  /** One entry per bar group, carrying every series' value in that group. */
  chartData: Array<Record<string, string | number>>;
  /** The series to plot, in the order that also assigns their colours. */
  series: ChartSeries[];
  /**
   * True when the series came from a grouping column rather than from separate
   * value columns. It says how the bars were built, not how many there are: a
   * grouped result with a single group is still grouped, and keeps the legend a
   * one-group query has always had.
   */
  isGrouped: boolean;
}

/**
 * A bar chart's counterpart to {@link buildLineChartSeries}: the same two
 * shapes, pivoted the same way, so one query groups identically in both panels.
 *
 * Grouped ([category, value, series]) merges rows into one entry per category,
 * with a slot for every series — a bar chart draws an absent pair as zero
 * rather than as a hole, unlike a line, which leaves a gap.
 *
 * Wide ([category, value1, value2, ...]) draws one bar per value column. Bars
 * used to read only column 2 here, so `[category, metric_a, metric_b]` silently
 * plotted `metric_a` alone — and `seriesColumn: 'none'`, whose whole purpose is
 * to ask for exactly this shape, lost every column it was meant to reveal.
 */
export function buildBarChartSeries(
  columns: ReadonlyArray<ColumnMeta>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  seriesColumn?: SeriesColumnSetting,
): BarChartSeries {
  const seriesColumnIndex = detectSeriesColumnIndex(columns, rows, seriesColumn);

  if (seriesColumnIndex !== null) {
    const series = assignSeriesKeys(
      rows.map((row) => String(row[seriesColumnIndex])),
    );
    const keyByLabel = new Map(series.map(({ key, label }) => [label, key]));
    const byCategory = new Map<string, Record<string, string | number>>();
    for (const row of rows) {
      const category = String(row[0]);
      let group = byCategory.get(category);
      if (!group) {
        group = { [X_KEY]: category };
        byCategory.set(category, group);
      }
      group[keyByLabel.get(String(row[seriesColumnIndex]))!] = toBarNumber(row[1]);
    }
    const chartData = Array.from(byCategory.values()).map((group) => {
      const item: Record<string, string | number> = { [X_KEY]: group[X_KEY]! };
      for (const { key } of series) {
        item[key] = group[key] ?? 0;
      }
      return item;
    });
    return { categoryKey: X_KEY, chartData, series, isGrouped: true };
  }

  const series = wideFormatSeries(columns, rows);
  const chartData = rows.map((row) => {
    const item: Record<string, string | number> = { [X_KEY]: String(row[0]) };
    series.forEach(({ key }, index) => {
      item[key] = toBarNumber(row[index + 1]);
    });
    return item;
  });

  return { categoryKey: X_KEY, chartData, series, isGrouped: false };
}

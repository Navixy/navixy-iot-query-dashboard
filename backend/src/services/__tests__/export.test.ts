import ExcelJS from 'exceljs';
import { PassThrough } from 'stream';
import { ExportService } from '../export.js';
// Type-only: the ESM runner links named imports for real, and an interface has
// no runtime export.
import type { ExcelExportOptions, ExportColumn } from '../export.js';

/**
 * Run the streaming Excel export into memory and read the real workbook back.
 *
 * Number formats are presentation, so they only exist in the generated file —
 * asserting on the values handed to ExcelJS cannot see them.
 */
async function dataSheetOf(options: ExcelExportOptions): Promise<ExcelJS.Worksheet> {
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const flushed = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
  });

  await ExportService.getInstance().streamExcel(options, sink);
  await flushed;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  const sheet = workbook.getWorksheet('Data');
  if (!sheet) throw new Error('no Data sheet in the generated workbook');
  return sheet;
}

/**
 * Chart generation is effectively pure (rows -> Chart.js script text), so it is
 * asserted directly. Both generators are private; reach them through an index
 * signature rather than exporting them purely for the tests.
 */
type ChartGenerators = {
  generateChartHTML(
    columns: ExportColumn[],
    rows: Record<string, unknown>[],
    chartConfig: { type?: string; xColumn?: string; yColumns?: string[] },
  ): string;
  generateGroupedChartHTML(
    columns: ExportColumn[],
    rows: Record<string, unknown>[],
    chartConfig: { xColumn: string; yColumn: string; groupColumn: string; groups?: string[] },
  ): string;
};

const service = ExportService.getInstance() as unknown as ChartGenerators;

const COLUMNS: ExportColumn[] = [
  { name: 'driver_name', type: 'text' },
  { name: 'total_score', type: 'numeric' },
  { name: 'vehicle_model', type: 'text' },
];

/** Rows shaped like the DO-332 report: one row per vehicle, descending score. */
function scoreRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    driver_name: `driver ${i}`,
    total_score: count - i,
    vehicle_model: i % 2 === 0 ? 'Camry' : 'Corolla',
  }));
}

/** Pull `labels: [...]` back out of the generated Chart.js config. */
function parseLabels(script: string): string[] {
  const match = script.match(/labels:\s*(\[[\s\S]*?\]),\n/);
  if (!match) throw new Error('no labels array in generated script');
  return JSON.parse(match[1]!);
}

interface ParsedDataset {
  label: string;
  data: unknown[];
  borderColor?: string;
}

/** Pull the datasets back out of the generated Chart.js config. */
function parseDatasets(script: string): ParsedDataset[] {
  const match = script.match(/datasets:\s*(\[[\s\S]*?\])\n/);
  if (!match) throw new Error('no datasets array in generated script');
  return JSON.parse(match[1]!) as ParsedDataset[];
}

/** Pull every dataset's `data: [...]` back out of the generated config. */
function parseDataArrays(script: string): unknown[][] {
  return parseDatasets(script).map(d => d.data);
}

/** Rows spanning `count` distinct groups, two x-points each. */
function groupedRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => [
    { driver_name: 'day 1', total_score: i, vehicle_model: `model ${i}` },
    { driver_name: 'day 2', total_score: i + 1, vehicle_model: `model ${i}` },
  ]).flat();
}

/** The chart columns shared by the DO-335 group-selection tests. */
const GROUPED_CONFIG = {
  xColumn: 'driver_name',
  yColumn: 'total_score',
  groupColumn: 'vehicle_model',
};

describe('ExportService chart generation', () => {
  describe('generateChartHTML (ungrouped)', () => {
    // DO-332: the chart capped at the first 200 rows while the table showed
    // every row. Reports commonly end in ORDER BY <metric> DESC, so the cap
    // dropped the worst performers rather than an arbitrary tail.
    it('plots every row past the old 200-row cap', () => {
      const rows = scoreRows(243);

      const script = service.generateChartHTML(COLUMNS, rows, {
        xColumn: 'driver_name',
        yColumns: ['total_score'],
      });

      expect(parseLabels(script)).toHaveLength(243);
      expect(parseDataArrays(script)).toEqual([rows.map(r => r.total_score)]);
    });

    it('keeps the lowest-scoring rows, which sort last', () => {
      const script = service.generateChartHTML(COLUMNS, scoreRows(243), {
        xColumn: 'driver_name',
        yColumns: ['total_score'],
      });

      const data = parseDataArrays(script)[0]!;
      expect(data[data.length - 1]).toBe(1);
      expect(parseLabels(script)).toContain('driver 242');
    });

    it('emits one dataset per y-column, each covering every row', () => {
      const script = service.generateChartHTML(COLUMNS, scoreRows(250), {
        xColumn: 'driver_name',
        yColumns: ['total_score', 'mileage_km'],
      });

      const data = parseDataArrays(script);
      expect(data).toHaveLength(2);
      expect(data.every(d => d.length === 250)).toBe(true);
    });

    it('neutralises a </script> payload in row data', () => {
      const script = service.generateChartHTML(
        COLUMNS,
        [{ driver_name: '</script><img src=x onerror=alert(1)>', total_score: 1 }],
        { xColumn: 'driver_name', yColumns: ['total_score'] },
      );

      expect(script).not.toContain('</script>');
      // Still round-trips to the original value for the chart itself.
      expect(parseLabels(script)).toEqual(['</script><img src=x onerror=alert(1)>']);
    });
  });

  describe('generateGroupedChartHTML', () => {
    it('plots every row past the old 500-row cap', () => {
      const script = service.generateGroupedChartHTML(COLUMNS, scoreRows(600), {
        xColumn: 'driver_name',
        yColumn: 'total_score',
        groupColumn: 'vehicle_model',
      });

      expect(parseLabels(script)).toHaveLength(600);
    });

    it('fills datasets for groups whose rows all sort past the old cut', () => {
      // `groups` was derived from every row while `sortedRows` was capped at
      // 500, so a group living entirely past the cut produced an all-null
      // dataset. Sorting is by x, so "zz" rows land last.
      const rows = [
        ...scoreRows(500),
        ...Array.from({ length: 10 }, (_, i) => ({
          driver_name: `zz driver ${i}`,
          total_score: 42,
          vehicle_model: 'Late Model',
        })),
      ];

      const script = service.generateGroupedChartHTML(COLUMNS, rows, {
        xColumn: 'driver_name',
        yColumn: 'total_score',
        groupColumn: 'vehicle_model',
      });

      const lateModel = JSON.parse(
        script.match(/datasets:\s*(\[[\s\S]*?\])\n/)![1]!,
      ).find((d: { label: string }) => d.label === 'Late Model');

      expect(lateModel).toBeDefined();
      expect(lateModel.data.filter((v: unknown) => v !== null)).toHaveLength(10);
    });
  });

  // DO-335: the generator kept the first ten groups and dropped the rest, so a
  // "Group by" over a high-cardinality column lost series 11+ with nothing in
  // the export to say so. The frontend now sends the series it plotted.
  describe('generateGroupedChartHTML group selection', () => {
    it('plots the picked groups, past the old 10-group cap', () => {
      const script = service.generateGroupedChartHTML(COLUMNS, groupedRows(14), {
        ...GROUPED_CONFIG,
        groups: ['model 11', 'model 13'],
      });

      expect(parseDatasets(script).map(d => d.label)).toEqual(['model 11', 'model 13']);
    });

    it('keeps the requested order, which is what assigns the colours', () => {
      // The frontend colours a series by its position in the list it sends, so
      // re-deriving the order here would repaint the exported chart.
      const script = service.generateGroupedChartHTML(COLUMNS, groupedRows(14), {
        ...GROUPED_CONFIG,
        groups: ['model 9', 'model 2'],
      });

      const datasets = parseDatasets(script);
      expect(datasets.map(d => d.label)).toEqual(['model 9', 'model 2']);
      expect(datasets[0]!.borderColor).toBe('#3b82f6'); // CHART_COLORS[0], as on screen
    });

    it('drops picked groups the re-query no longer returns', () => {
      // The export re-runs the query, so its rows need not still carry every
      // group the browser saw; a stale pick must not become an empty series.
      const script = service.generateGroupedChartHTML(COLUMNS, groupedRows(14), {
        ...GROUPED_CONFIG,
        groups: ['model 3', 'retired model'],
      });

      expect(parseDatasets(script).map(d => d.label)).toEqual(['model 3']);
    });

    it('falls back to the first ten groups when no list is sent', () => {
      // An older client sends only the columns; both sides still default to 10.
      const script = service.generateGroupedChartHTML(COLUMNS, groupedRows(14), GROUPED_CONFIG);

      expect(parseDatasets(script).map(d => d.label)).toEqual(
        Array.from({ length: 10 }, (_, i) => `model ${i}`),
      );
    });

    it('falls back to the default set when the re-query strands every pick', () => {
      // resolvePlottedGroups does the same on screen rather than blank the chart.
      const script = service.generateGroupedChartHTML(COLUMNS, groupedRows(14), {
        ...GROUPED_CONFIG,
        groups: ['gone a', 'gone b'],
      });

      expect(parseDatasets(script)).toHaveLength(10);
    });

    it('ignores a groups value that is not an array', () => {
      // chartSettings is forwarded straight off the request body, unvalidated.
      const script = service.generateGroupedChartHTML(COLUMNS, groupedRows(14), {
        ...GROUPED_CONFIG,
        groups: 'model 3' as unknown as string[],
      });

      expect(parseDatasets(script)).toHaveLength(10);
    });
  });
});

/**
 * DO-273: a Postgres `date` reaches the export pipeline as the calendar string
 * Postgres sent ("2026-05-12"), not as an instant. A day has no clock and no
 * zone, so rendering it in the export's timezone would move it to the previous
 * day for every viewer west of UTC — the same shift the chart axis had.
 */
describe('ExportService calendar days', () => {
  const csvService = ExportService.getInstance();
  const DAY_COLUMNS: ExportColumn[] = [
    { name: 'day', type: 'date' },
    { name: 'total', type: 'integer' },
  ];

  const csvBody = (timeZone: string | undefined) =>
    csvService.generateCSV({
      title: 'daily',
      columns: DAY_COLUMNS,
      rows: [['2026-05-12', 7]],
      executedAt: new Date('2026-05-12T10:00:00Z'),
      timeZone,
      dateFormat: 'mm-dd-yyyy',
      timeFormat: 'h12',
    }).toString('utf8').split('\n')[1];

  it('renders a date cell as that day, in every export timezone', () => {
    expect(csvBody('America/New_York')).toBe('05-12-2026,7');
    expect(csvBody('Pacific/Auckland')).toBe('05-12-2026,7');
    expect(csvBody(undefined)).toBe('05-12-2026,7');
  });

  it('still renders a timestamp cell in the export timezone', () => {
    // The neighbouring case, so the day rule cannot swallow real instants:
    // 03:00 UTC is the previous evening in New York.
    const line = csvService.generateCSV({
      title: 'events',
      columns: [{ name: 'at', type: 'timestamptz' }],
      rows: [['2026-05-12T03:00:00.000Z']],
      executedAt: new Date('2026-05-12T10:00:00Z'),
      timeZone: 'America/New_York',
      dateFormat: 'mm-dd-yyyy',
      timeFormat: 'h12',
    }).toString('utf8').split('\n')[1];

    expect(line).toMatch(/^05-11-2026 11:00 PM$/);
  });

  it('gives Excel the day itself, unshifted', () => {
    // ExcelJS turns a Date into a serial through its UTC fields, so a cell
    // showing 12 May must carry UTC midnight of 12 May.
    type CellCoercion = {
      coerceCellValue(
        value: unknown, isDateType: boolean, isNumeric: boolean, timeZone: string | undefined,
      ): { value: unknown; isDate: boolean; isDay?: boolean };
    };
    const coerce = ExportService.getInstance() as unknown as CellCoercion;

    const cell = coerce.coerceCellValue('2026-05-12', true, false, 'America/New_York');

    expect(cell.isDate).toBe(true);
    expect(cell.isDay).toBe(true);
    expect((cell.value as Date).toISOString()).toBe('2026-05-12T00:00:00.000Z');
  });

  it('prints no time of day in the generated workbook', async () => {
    // Read the real .xlsx back rather than the value handed to ExcelJS: what a
    // day cell *shows* is its number format, and a correct serial under a
    // date+time format still prints "12:00 AM" — hours a SQL date never had.
    const sheet = await dataSheetOf({
      title: 'daily',
      columns: [
        { name: 'day', type: 'date' },
        { name: 'at', type: 'timestamptz' },
        { name: 'total', type: 'integer' },
      ],
      rows: [['2026-05-12', '2026-05-12T03:00:00.000Z', 7]],
      executedAt: new Date('2026-05-12T10:00:00Z'),
      timeZone: 'America/New_York',
      dateFormat: 'mm-dd-yyyy',
      timeFormat: 'h12',
    });

    const dayCell = sheet.getRow(2).getCell(1);
    expect(dayCell.numFmt).toBe('mm-dd-yyyy');
    expect((dayCell.value as Date).toISOString()).toBe('2026-05-12T00:00:00.000Z');

    // The neighbouring cell: a real instant still carries the time it happened
    // at, in the export's zone, so the day rule cannot flatten timestamps.
    const instantCell = sheet.getRow(2).getCell(2);
    expect(instantCell.numFmt).toBe('mm-dd-yyyy hh:mm AM/PM');
    expect((instantCell.value as Date).toISOString()).toBe('2026-05-11T23:00:00.000Z');
  });

  it('labels an exported chart x axis with the day', () => {
    const script = (ExportService.getInstance() as unknown as ChartGenerators)
      .generateChartHTML(DAY_COLUMNS, [{ day: '2026-05-12', total: 7 }], {
        xColumn: 'day',
        yColumns: ['total'],
      });

    expect(parseLabels(script)).toEqual(['12/05/2026']);
  });
});

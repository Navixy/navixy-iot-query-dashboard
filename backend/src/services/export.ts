/**
 * Export Service
 * Handles generation of Excel and HTML exports for composite reports
 */

import ExcelJS from 'exceljs';
import type { Writable } from 'stream';
import { logger } from '../utils/logger.js';
import {
  isTimestampLikeValue,
  parseCalendarDay,
  parseTimestampValue,
  type CalendarDay,
} from '../utils/datetime.js';
import { isDisplayableCoordinate } from '../utils/gpsDetection.js';
import type { DateFormat, TimeFormat } from './userPreferences.js';

/**
 * Grouped series plotted when an export request carries no explicit list.
 * Mirrors DEFAULT_GROUP_LIMIT in src/lib/chartGroups.ts (DO-335) — the frontend
 * normally sends the series it plotted, and this is the shared answer for when
 * it does not.
 */
const DEFAULT_GROUP_LIMIT = 10;

export interface ExportColumn {
  name: string;
  type: string;
}

export interface ExcelHeaderConfig {
  enabled: boolean;
  title?: string;
  description?: string;
  column?: string;
}

export interface ExcelExportOptions {
  title: string;
  description?: string | null;
  columns: ExportColumn[];
  rows: unknown[][];
  executedAt: Date;
  excelHeader?: ExcelHeaderConfig;
  // IANA identifier (e.g. "Europe/Belgrade"). When set, date cells and the
  // Report Info "Executed At" entry are rendered with wall-clock times in
  // this zone so they match what the Data Table shows on screen. The caller
  // is expected to validate the identifier before passing it in.
  timeZone?: string;
  // Optional pattern overrides; when absent or 'default', exports keep the
  // legacy `dd/mm/yy hh:mm` shape so existing reports look the same.
  dateFormat?: DateFormat;
  timeFormat?: TimeFormat;
}

export interface HTMLExportOptions {
  title: string;
  description?: string | null;
  columns: ExportColumn[];
  rows: unknown[][];
  config: {
    table?: { enabled: boolean; pageSize?: number; showTotals?: boolean };
    chart?: { enabled: boolean; type?: string; xColumn?: string; yColumns?: string[] };
    map?: { enabled: boolean; latColumn?: string; lonColumn?: string };
  };
  gpsColumns?: { latColumn: string; lonColumn: string } | null;
  includeChart?: boolean;
  executedAt: Date;
  // Override chart settings from frontend
  chartSettings?: {
    xColumn?: string;
    yColumn?: string;
    groupColumn?: string;
    groups?: string[];
  };
  // Map view state from frontend (center and zoom)
  mapSettings?: {
    center: [number, number];
    zoom: number;
  };
  // Original (pre-geocoded) data for map rendering when geocoding is applied
  mapColumns?: ExportColumn[];
  mapRows?: unknown[][];
  // IANA identifier; when set, dates in the table, chart labels and the
  // "Generated on" meta header are rendered in this zone.
  timeZone?: string;
  dateFormat?: DateFormat;
  timeFormat?: TimeFormat;
}

const DATE_COLUMN_TYPES = ['timestamp', 'timestamptz', 'date'];

function isDateColumnByType(col: ExportColumn): boolean {
  return DATE_COLUMN_TYPES.some(t => col.type.includes(t));
}

/**
 * Check whether the column named `columnName` should be treated as a date
 * column — either by its pg type or by heuristic value sampling.
 */
function isDateColumn(
  columns: ExportColumn[],
  columnName: string,
  rows?: Record<string, unknown>[],
): boolean {
  const col = columns.find(c => c.name === columnName);
  if (!col) return false;
  if (isDateColumnByType(col)) return true;
  if (!rows || rows.length === 0) return false;
  let checked = 0;
  let matched = 0;
  for (let r = 0; r < rows.length && checked < 5; r++) {
    const v = rows[r]![columnName];
    if (v == null || v === '') continue;
    checked++;
    if (isTimestampLikeValue(v)) matched++;
  }
  return checked > 0 && matched === checked;
}

interface ZoneDateComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// `new Intl.DateTimeFormat` is not cheap; large exports format many thousands
// of rows, so we keep one formatter per zone for the lifetime of the process.
const zoneFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  zoneFormatterCache.set(timeZone, formatter);
  return formatter;
}

function getDateComponentsInZone(date: Date, timeZone: string): ZoneDateComponents | null {
  try {
    const parts = getZoneFormatter(timeZone).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    // Some ICU builds return "24" for midnight under hour12:false; normalise it.
    const hourStr = map.hour === '24' ? '00' : map.hour;
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(hourStr),
      minute: Number(map.minute),
      second: Number(map.second),
    };
  } catch {
    return null;
  }
}

/**
 * Excel stores dates as plain serial numbers without any timezone awareness:
 * when a cell is rendered as `dd/mm/yy hh:mm` the integer/fractional parts of
 * the serial are unpacked verbatim. To make Excel display the wall-clock time
 * of `utcDate` in `timeZone`, we synthesise a Date whose UTC components match
 * the wall-clock components in the target zone. ExcelJS then turns that into a
 * serial via `getTime() / 86400000`, which unpacks back to the same numbers.
 */
function shiftDateToZone(utcDate: Date, timeZone: string): Date {
  const c = getDateComponentsInZone(utcDate, timeZone);
  if (!c) return utcDate;
  return new Date(Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second));
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Translate a user-pref date format value to an ExcelJS `numFmt` string.
 * The time portion is appended by {@link buildExcelNumFmt}. `undefined`
 * falls through to the 4-digit slash form — the same shape the legacy
 * `default` UI label promised ("01/12/2021 (DD/MM/YYYY)").
 */
function excelDatePart(fmt: DateFormat | undefined): string {
  switch (fmt) {
    case 'dd.mm.yyyy':
      return 'dd.mm.yyyy';
    case 'mm-dd-yyyy':
      return 'mm-dd-yyyy';
    case 'yyyy-mm-dd':
      return 'yyyy-mm-dd';
    case 'dd-mmm-yyyy':
      return 'd mmm yyyy';
    case 'dd-mmmm-yyyy':
      return 'd mmmm yyyy';
    case 'dd/mm/yyyy':
    default:
      return 'dd/mm/yyyy';
  }
}

// Excel's number-format mini-language is locale-agnostic: `HH:mm` renders 24h
// without an AM/PM indicator, `hh:mm AM/PM` renders 12h with the marker.
// `hh:mm` without an indicator silently renders 24h, which is what produced
// the old "default" dead branch (lowercase `hh` looks 12-hour-ish but isn't).
function excelTimePart(fmt: TimeFormat | undefined): string {
  return fmt === 'h24' ? 'HH:mm' : 'hh:mm AM/PM';
}

function buildExcelNumFmt(
  dateFmt: DateFormat | undefined,
  timeFmt: TimeFormat | undefined,
): string {
  return `${excelDatePart(dateFmt)} ${excelTimePart(timeFmt)}`;
}

/**
 * Render calendar fields in the user's date format. Shared by
 * {@link formatDateWithPrefs}, which takes them from an instant read in the
 * export's timezone, and by the date-only path, where the value is already a
 * calendar day and there is no instant to read (DO-273).
 */
/** A calendar day as the Date whose UTC fields are that day, midnight. */
function calendarDayToUtcDate(c: CalendarDay): Date {
  return new Date(Date.UTC(c.year, c.month - 1, c.day));
}

function formatCalendarDay(c: CalendarDay, dateFmt: DateFormat | undefined): string {
  const dd = String(c.day).padStart(2, '0');
  const mm = String(c.month).padStart(2, '0');
  const yyyy = String(c.year);

  switch (dateFmt) {
    case 'dd.mm.yyyy':
      return `${dd}.${mm}.${yyyy}`;
    case 'mm-dd-yyyy':
      return `${mm}-${dd}-${yyyy}`;
    case 'yyyy-mm-dd':
      return `${yyyy}-${mm}-${dd}`;
    case 'dd-mmm-yyyy':
      return `${c.day} ${MONTHS_SHORT[c.month - 1]} ${yyyy}`;
    case 'dd-mmmm-yyyy':
      return `${c.day} ${MONTHS_LONG[c.month - 1]} ${yyyy}`;
    case 'dd/mm/yyyy':
    default:
      return `${dd}/${mm}/${yyyy}`;
  }
}

/**
 * Render `date` for CSV/HTML/info-sheet output using the user's date/time
 * format preferences. When both are 'default' (or unset), keeps the legacy
 * `dd/mm/yy hh:mm` shape.
 */
function formatDateWithPrefs(
  date: Date,
  timeZone: string | undefined,
  dateFmt: DateFormat | undefined,
  timeFmt: TimeFormat | undefined,
): string {
  let day: number, month: number, year: number, hour: number, minute: number;
  if (timeZone) {
    const c = getDateComponentsInZone(date, timeZone);
    if (c) {
      ({ day, month, year, hour, minute } = c);
    } else {
      day = date.getDate();
      month = date.getMonth() + 1;
      year = date.getFullYear();
      hour = date.getHours();
      minute = date.getMinutes();
    }
  } else {
    day = date.getDate();
    month = date.getMonth() + 1;
    year = date.getFullYear();
    hour = date.getHours();
    minute = date.getMinutes();
  }

  const datePart = formatCalendarDay({ year, month, day }, dateFmt);

  const mm2 = String(minute).padStart(2, '0');
  let timePart: string;
  if (timeFmt === 'h12') {
    const period = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    timePart = `${String(h12).padStart(2, '0')}:${mm2} ${period}`;
  } else {
    // 'h24' or undefined — render 24-hour. `undefined` falls through to 24h
    // because callers omit `timeFormat` only when the user has no preference
    // resolved (rare; backend reads default to 'h12' now), and 24h is the
    // safer fallback than guessing a 12-hour AM/PM marker.
    timePart = `${String(hour).padStart(2, '0')}:${mm2}`;
  }

  return `${datePart} ${timePart}`;
}

export class ExportService {
  private static instance: ExportService;

  static getInstance(): ExportService {
    if (!ExportService.instance) {
      ExportService.instance = new ExportService();
    }
    return ExportService.instance;
  }

  /**
   * Stream an Excel (.xlsx) export directly to a writable (typically the HTTP
   * response) using ExcelJS's streaming WorkbookWriter.
   *
   * Rows are committed and flushed to the output one at a time, so peak memory
   * stays roughly flat regardless of row count. The previous buffered path
   * (`new Workbook()` + `workbook.xlsx.writeBuffer()`) held the entire workbook
   * — every cell as an object plus one giant XML string — in the ~2 GB Node
   * heap, and OOM'd the process on large exports once DO-277 raised the
   * server-side row cap to 100k+ (see routes/panels.ts, utils/exportPolicy.ts).
   * Streaming also starts emitting bytes immediately, so the response no longer
   * sits silent past nginx's proxy_read_timeout on big/slow exports.
   *
   * The caller must set Content-Type / Content-Disposition before calling this.
   * Content-Length is intentionally omitted — the body is chunked. On success
   * the writable is ended by the workbook commit; on failure this rejects and
   * the caller should abort the response (the headers are likely already sent).
   */
  async streamExcel(options: ExcelExportOptions, out: Writable): Promise<void> {
    const { title, description, columns, rows, executedAt, excelHeader, timeZone, dateFormat, timeFormat } = options;
    const cellNumFmt = buildExcelNumFmt(dateFormat, timeFormat);

    const headerActive = !!(excelHeader?.enabled && (excelHeader.title || excelHeader.description));
    const rowOffset = headerActive ? 2 : 0;
    const colHeaderRowNum = 1 + rowOffset;

    // Single pass over the already-in-memory result rows to decide which
    // columns are non-empty and how wide each should be. This only reads the
    // source array the route handed us — it builds no ExcelJS structures — so
    // it preserves the old empty-column filter and width auto-fit without
    // adding asymptotic memory (the streaming writer can't revisit committed
    // rows to auto-fit after the fact).
    const colCount = columns.length;
    const nonEmpty = new Array<boolean>(colCount).fill(false);
    // Date cells render as the formatted display string (e.g. "23/06/2026 14:30"),
    // not the raw ISO/Date source value — which can be ~30 chars as an ISO string
    // or ~60 as a Date.toString(). Size date columns from that display width so
    // the auto-fit isn't blown out by the long source; a sample formatted with
    // the export's own date prefs keeps long-month formats ("3 September 2026")
    // honest. Non-date columns measure their raw value as before.
    const colIsDate = columns.map(isDateColumnByType);
    const dateDisplayWidth = formatDateWithPrefs(executedAt, timeZone, dateFormat, timeFormat).length;
    const maxLen = columns.map((col, idx) =>
      colIsDate[idx]! ? Math.max(col.name.length, dateDisplayWidth) : col.name.length,
    );
    for (const row of rows) {
      for (let idx = 0; idx < colCount; idx++) {
        const val = row[idx];
        if (val === null || val === undefined || val === '') continue;
        nonEmpty[idx] = true;
        if (colIsDate[idx]!) continue; // width already fixed to the formatted display
        const len = typeof val === 'string' ? val.length : String(val).length;
        if (len > maxLen[idx]!) maxLen[idx] = len;
      }
    }
    const visibleIdx: number[] = [];
    for (let idx = 0; idx < colCount; idx++) {
      if (nonEmpty[idx]) visibleIdx.push(idx);
    }
    const visibleColumns = visibleIdx.map(idx => columns[idx]!);

    // Per-visible-column classification, computed once rather than per cell:
    // the date/numeric decision depends only on the column type.
    const visKinds = visibleColumns.map(col => ({
      isDateType: isDateColumnByType(col),
      isNumeric:
        col.type.includes('int') ||
        col.type.includes('numeric') ||
        col.type.includes('real') ||
        col.type.includes('double'),
    }));

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: out,
      useStyles: true,
      // Inline strings rather than a shared-strings table: export data is
      // high-cardinality, and a shared table would have to live in memory for
      // the whole workbook, defeating the point of streaming.
      useSharedStrings: false,
    });
    workbook.creator = 'Dashboard Studio';
    workbook.created = executedAt;

    // The writer pipes the zip into `out` (the response) immediately — before
    // `workbook.commit()` is awaited. If the client disconnects mid-download,
    // `out` emits 'error' (e.g. ECONNRESET); without a listener that event is
    // unhandled and can crash the whole process. Capture + log it here. The
    // captured error is re-thrown once commit() settles (below) so the route
    // treats the aborted download as the failure it is — and because it keeps
    // the original socket `code` (ECONNRESET/EPIPE), the errorHandler classifies
    // it as a client abort rather than relying on ExcelJS's wrapper, which can
    // drop that code.
    let streamError: Error | null = null;
    out.on('error', (err: unknown) => {
      if (!streamError) {
        streamError = err instanceof Error ? err : new Error(String(err));
      }
      logger.warn('Export output stream error (client disconnected?)', {
        message: streamError.message,
      });
    });

    // Freeze the column-header row (and report-header rows when present). The
    // streaming writer exposes `views` read-only, so it must be passed at sheet
    // creation rather than assigned afterwards.
    const dataSheet = workbook.addWorksheet('Data', {
      views: [{ state: 'frozen', ySplit: colHeaderRowNum }],
    });
    // Width-only column defs (no `header`, so the writer adds no auto-header
    // row — we write the header manually below). Keys are unnecessary since we
    // write cells positionally, and omitting them avoids duplicate-key issues
    // when a query returns columns with the same name.
    dataSheet.columns = visibleIdx.map(idx => ({
      width: Math.min(Math.max(maxLen[idx]! + 2, 10), 50),
    }));

    // Insert report header (title/description) if enabled
    if (headerActive) {
      const colLetter = excelHeader!.column?.match(/^[A-Z]$/) ? excelHeader!.column! : 'A';
      // Address/merge by numeric (row, col) indices rather than letter math:
      // `String.fromCharCode('A' + n)` only yields a valid column letter for
      // <=26 columns, so the old letter-based range silently dropped the merged
      // header band on wider tables. Numeric merge works for any column count.
      const startCol = colLetter.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
      const lastCol = visibleColumns.length;
      const canMerge = lastCol > 1 && startCol <= lastCol;

      if (excelHeader!.title) {
        const titleCell = dataSheet.getCell(1, startCol);
        titleCell.value = excelHeader!.title;
        titleCell.font = { bold: true, size: 14 };
        if (canMerge) {
          dataSheet.mergeCells(1, startCol, 1, lastCol);
        }
      }

      if (excelHeader!.description) {
        const descCell = dataSheet.getCell(2, startCol);
        descCell.value = excelHeader!.description;
        descCell.font = { italic: true, size: 11, color: { argb: 'FF666666' } };
        if (canMerge) {
          dataSheet.mergeCells(2, startCol, 2, lastCol);
        }
      }
    }

    // Column header row. Committing it also flushes any report-header rows
    // above it, in order (the writer commits all rows up to the committed one).
    const headerRow = dataSheet.getRow(colHeaderRowNum);
    visibleColumns.forEach((col, idx) => {
      headerRow.getCell(idx + 1).value = col.name;
    });
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.commit();

    // Stream data rows: build, format date cells, commit (flush + free) each.
    for (const row of rows) {
      const values = new Array<ExcelJS.CellValue>(visibleColumns.length);
      const dateCellCols: number[] = [];
      for (let i = 0; i < visibleColumns.length; i++) {
        const kind = visKinds[i]!;
        const { value, isDate } = this.coerceCellValue(row[visibleIdx[i]!], kind.isDateType, kind.isNumeric, timeZone);
        values[i] = value;
        if (isDate) dateCellCols.push(i);
      }
      const dataRow = dataSheet.addRow(values);
      for (const i of dateCellCols) {
        dataRow.getCell(i + 1).numFmt = cellNumFmt;
      }
      dataRow.commit();
    }
    dataSheet.commit();

    // Create info sheet (header written manually, same as the data sheet).
    const infoSheet = workbook.addWorksheet('Report Info');
    infoSheet.columns = [
      { key: 'property', width: 20 },
      { key: 'value', width: 60 },
    ];
    const infoHeader = infoSheet.getRow(1);
    infoHeader.getCell(1).value = 'Property';
    infoHeader.getCell(2).value = 'Value';
    infoHeader.font = { bold: true };
    infoHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };
    infoHeader.commit();

    const addInfo = (property: string, value: ExcelJS.CellValue): void => {
      infoSheet.addRow({ property, value }).commit();
    };
    addInfo('Report Title', title);
    if (description) {
      addInfo('Description', description);
    }
    addInfo('Executed At', timeZone
      ? this.formatShortDateTime(executedAt, timeZone, dateFormat, timeFormat)
      : executedAt.toISOString());
    if (timeZone) {
      addInfo('Timezone', timeZone);
    }
    addInfo('Total Rows', rows.length);
    addInfo('Total Columns', columns.length);
    infoSheet.commit();

    // Finalize the zip and end the output stream. Prefer the captured socket
    // error over a commit() rejection: a client abort makes ExcelJS reject with
    // a wrapper that may have dropped the original ECONNRESET/EPIPE code, while
    // `streamError` still carries it (so the route/errorHandler log a clean
    // client abort, not a server error with a stack).
    try {
      await workbook.commit();
    } catch (commitErr) {
      throw streamError ?? commitErr;
    }
    // commit() can *resolve* even though the output stream already failed:
    // ExcelJS finished writing to its end of the pipe, but the bytes never
    // reached the aborted client. Surface that as a failure rather than logging
    // a success for a download nobody received.
    if (streamError) {
      throw streamError;
    }

    logger.info('Streamed Excel export', {
      title,
      rowCount: rows.length,
      columnCount: columns.length,
      visibleColumns: visibleColumns.length,
      headerEnabled: headerActive,
    });
  }

  /**
   * Coerce a raw cell value into what ExcelJS should store, mirroring the
   * type handling the buffered path used: date-ish values become (optionally
   * zone-shifted) Date objects flagged for date number-formatting; numeric
   * columns are parsed to numbers; everything else passes through. Nulls render
   * as an empty string.
   *
   * `isDateType`/`isNumeric` are the column's classification, precomputed once
   * per column by the caller — re-deriving them from `col.type` here would scan
   * the type string for every cell (millions of times on a large export).
   */
  private coerceCellValue(
    value: unknown,
    isDateType: boolean,
    isNumeric: boolean,
    timeZone: string | undefined,
  ): { value: ExcelJS.CellValue; isDate: boolean } {
    if (value === null || value === undefined) {
      return { value: '', isDate: false };
    }
    if (isDateType || value instanceof Date || isTimestampLikeValue(value)) {
      // A calendar day is stored at UTC midnight and never zone-shifted:
      // ExcelJS converts a Date to a serial through its UTC fields, so those
      // are exactly the fields the cell should carry (DO-273).
      const day = parseCalendarDay(value);
      if (day) {
        return { value: calendarDayToUtcDate(day), isDate: true };
      }
      const dateValue = value instanceof Date ? value : parseTimestampValue(String(value));
      if (!dateValue) {
        return { value: value as ExcelJS.CellValue, isDate: false };
      }
      return { value: timeZone ? shiftDateToZone(dateValue, timeZone) : dateValue, isDate: true };
    }
    if (isNumeric) {
      // A numeric-typed column can carry string-encoded numbers (pg returns
      // numeric/bigint as strings to preserve precision) or a non-numeric
      // sentinel ('N/A', '3 days', …). Parse a string only when it is numeric
      // *in full*: parseFloat('3 days') → 3 would silently store a truncated
      // number, diverging from the CSV/text path, which keeps '3 days' verbatim.
      // Number() rejects trailing garbage; the empty-string guard keeps blanks
      // blank (Number('') === 0). Non-numeric strings — and a NaN number — fall
      // back to the raw value.
      if (typeof value === 'string') {
        const trimmed = value.trim();
        const num = trimmed === '' ? NaN : Number(trimmed);
        if (Number.isNaN(num)) {
          return { value: value as ExcelJS.CellValue, isDate: false };
        }
        return { value: num, isDate: false };
      }
      if (typeof value === 'number' && Number.isNaN(value)) {
        return { value: value as ExcelJS.CellValue, isDate: false };
      }
      return { value: value as ExcelJS.CellValue, isDate: false };
    }
    return { value: value as ExcelJS.CellValue, isDate: false };
  }

  /**
   * Generate CSV file from composite report data
   */
  generateCSV(options: ExcelExportOptions): Buffer {
    const { columns, rows, timeZone, dateFormat, timeFormat } = options;

    // Filter out empty columns
    const emptyColumnIndices = new Set<number>();
    columns.forEach((col, idx) => {
      const isEmpty = rows.every(row => {
        const val = row[idx];
        return val === null || val === undefined || val === '';
      });
      if (isEmpty) {
        emptyColumnIndices.add(idx);
      }
    });
    const visibleColumns = columns.filter((_, idx) => !emptyColumnIndices.has(idx));

    const lines: string[] = [];

    // Add header row
    lines.push(visibleColumns.map(col => this.escapeCSVField(col.name)).join(','));

    // Add data rows
    rows.forEach((row) => {
      const csvRow: string[] = [];
      columns.forEach((col, idx) => {
        // Skip empty columns
        if (emptyColumnIndices.has(idx)) {
          return;
        }

        const value = row[idx];

        if (value === null || value === undefined) {
          csvRow.push('');
          return;
        }

        // Format dates in short locale format
        if (isDateColumnByType(col) || value instanceof Date || isTimestampLikeValue(value)) {
          const text = this.formatDateCell(value, timeZone, dateFormat, timeFormat);
          if (text !== null) {
            csvRow.push(this.escapeCSVField(text));
            return;
          }
        }
        
        // Trim trailing zeros for numeric values
        if (typeof value === 'number') {
          csvRow.push(this.escapeCSVField(this.formatNumericValue(value)));
          return;
        }
        
        // Check for string numbers with trailing zeros
        if (typeof value === 'string' && /^-?\d+\.\d+0+$/.test(value)) {
          const num = parseFloat(value);
          if (!isNaN(num)) {
            csvRow.push(this.escapeCSVField(this.formatNumericValue(num)));
            return;
          }
        }
        
        csvRow.push(this.escapeCSVField(String(value)));
      });
      lines.push(csvRow.join(','));
    });
    
    const csvContent = lines.join('\n');
    
    logger.info('Generated CSV export', { 
      rowCount: rows.length, 
      columnCount: visibleColumns.length 
    });
    
    return Buffer.from(csvContent, 'utf-8');
  }

  /**
   * Escape a field for CSV format
   */
  private escapeCSVField(value: string): string {
    // If field contains comma, quote, or newline, wrap in quotes
    if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
      // Escape quotes by doubling them
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Format date/time for CSV/HTML output, honouring user preferences when
   * supplied. Falls back to the legacy `dd/mm/yy hh:mm` shape when none of
   * the format overrides are set, so existing reports look unchanged.
   * Uses manual formatting to avoid Node.js locale issues in Docker/Alpine.
   */
  private formatShortDateTime(
    date: Date,
    timeZone?: string,
    dateFormat?: DateFormat,
    timeFormat?: TimeFormat,
  ): string {
    return formatDateWithPrefs(date, timeZone, dateFormat, timeFormat);
  }

  /**
   * Display text for a date-ish cell, or null when the value is not one (so the
   * caller can fall through to its numeric/plain-string handling).
   *
   * A bare "YYYY-MM-DD" renders as that day: it is a calendar day, not an
   * instant, so reading it in the export's timezone would move it to the
   * previous day west of UTC and append a clock the query never returned. Every
   * other date-ish value is an instant and is rendered in that zone (DO-273).
   */
  private formatDateCell(
    value: unknown,
    timeZone?: string,
    dateFormat?: DateFormat,
    timeFormat?: TimeFormat,
  ): string | null {
    const day = parseCalendarDay(value);
    if (day) return formatCalendarDay(day, dateFormat);
    const date = value instanceof Date ? value : parseTimestampValue(String(value ?? ''));
    return date ? this.formatShortDateTime(date, timeZone, dateFormat, timeFormat) : null;
  }

  /**
   * Format a numeric value, trimming trailing zeros (for coordinates)
   */
  private formatNumericValue(value: number): string {
    // Remove trailing zeros while keeping precision
    return parseFloat(value.toPrecision(15)).toString();
  }

  /**
   * Check if a column is empty (all values are null/undefined/empty string)
   */
  private isColumnEmpty(rows: Record<string, unknown>[], colName: string): boolean {
    return rows.every(row => {
      const val = row[colName];
      return val === null || val === undefined || val === '';
    });
  }

  /**
   * Filter out columns that have no values
   */
  private filterEmptyColumns(columns: ExportColumn[], rows: Record<string, unknown>[]): ExportColumn[] {
    return columns.filter(col => !this.isColumnEmpty(rows, col.name));
  }

  /**
   * Generate self-contained HTML from composite report data
   */
  async generateHTML(options: HTMLExportOptions): Promise<string> {
    const { title, description, columns, rows, config, gpsColumns, includeChart, executedAt, chartSettings, timeZone, dateFormat, timeFormat } = options;

    // Convert rows to objects for easier template processing
    const rowObjects = rows.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        obj[col.name] = row[idx];
      });
      return obj;
    });

    // Generate table HTML
    const tableHTML = this.generateTableHTML(columns, rowObjects, timeZone, dateFormat, timeFormat);

    // Generate chart HTML/JS if enabled
    // Use chartSettings from frontend if provided, otherwise fall back to config
    let chartHTML = '';
    const effectiveXColumn = chartSettings?.xColumn || config.chart?.xColumn;
    const effectiveYColumn = chartSettings?.yColumn;
    const effectiveGroupColumn = chartSettings?.groupColumn;
    const effectiveYColumns = effectiveYColumn ? [effectiveYColumn] : config.chart?.yColumns;
    
    if (includeChart && config.chart?.enabled && effectiveXColumn && effectiveYColumns?.length) {
      // If groupColumn is specified, generate grouped chart
      if (effectiveGroupColumn && effectiveYColumns[0]) {
        chartHTML = this.generateGroupedChartHTML(columns, rowObjects, {
          xColumn: effectiveXColumn,
          yColumn: effectiveYColumns[0],
          groupColumn: effectiveGroupColumn,
          ...(chartSettings?.groups ? { groups: chartSettings.groups } : {}),
        }, timeZone, dateFormat, timeFormat);
      } else {
        const chartConfigForGeneration: { type?: string; xColumn?: string; yColumns?: string[] } = {
          xColumn: effectiveXColumn,
          yColumns: effectiveYColumns,
        };
        if (config.chart?.type) {
          chartConfigForGeneration.type = config.chart.type;
        }
        chartHTML = this.generateChartHTML(columns, rowObjects, chartConfigForGeneration, timeZone, dateFormat, timeFormat);
      }
    }

    // Generate map HTML if enabled and GPS data available
    let mapHTML = '';
    if (gpsColumns && config.map?.enabled) {
      // Use original (pre-geocoded) data for map when geocoding was applied
      let mapRowObjects = rowObjects;
      if (options.mapColumns && options.mapRows) {
        mapRowObjects = options.mapRows.map((row) => {
          const obj: Record<string, unknown> = {};
          options.mapColumns!.forEach((col, idx) => {
            obj[col.name] = row[idx];
          });
          return obj;
        });
      }
      mapHTML = this.generateMapHTML(mapRowObjects, gpsColumns, options.mapSettings);
    }

    // Build full HTML document
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHTML(title)}</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #fff;
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
    }
    
    @media print {
      body {
        padding: 0;
        max-width: none;
      }
      .no-print {
        display: none !important;
      }
      .page-break {
        page-break-before: always;
      }
      table {
        font-size: 10px;
        word-break: break-word;
      }
      th, td {
        padding: 4px 6px;
      }
      th {
        white-space: normal;
      }
    }
    
    header {
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #e0e0e0;
    }
    
    h1 {
      font-size: 28px;
      font-weight: 600;
      margin-bottom: 10px;
      color: #1a1a1a;
    }
    
    .description {
      font-size: 16px;
      color: #666;
      margin-bottom: 10px;
    }
    
    .meta {
      font-size: 12px;
      color: #999;
    }
    
    section {
      margin-bottom: 40px;
    }
    
    h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 15px;
      color: #1a1a1a;
      padding-bottom: 8px;
      border-bottom: 1px solid #e0e0e0;
    }
    
    /* Table styles */
    .table-container {
      overflow-x: auto;
      margin-bottom: 20px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      table-layout: auto;
    }
    
    th, td {
      padding: 10px 12px;
      text-align: left;
      border: 1px solid #e0e0e0;
      overflow-wrap: break-word;
    }
    
    th {
      background: #f5f5f5;
      font-weight: 600;
      white-space: nowrap;
    }
    
    tr:nth-child(even) {
      background: #fafafa;
    }
    
    tr:hover {
      background: #f0f7ff;
    }
    
    /* Chart styles */
    .chart-container {
      width: 100%;
      height: 400px;
      margin-bottom: 20px;
    }
    
    /* Map styles */
    .map-container {
      width: 100%;
      height: 400px;
      margin-bottom: 20px;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
    }
    
    /* Footer */
    footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
  </style>
  ${chartHTML ? this.getChartLibraryScript() : ''}
  ${mapHTML ? this.getMapLibraryScript() : ''}
</head>
<body>
  <header>
    <h1>${this.escapeHTML(title)}</h1>
    ${description ? `<p class="description">${this.escapeHTML(description)}</p>` : ''}
    <p class="meta">Generated on ${this.escapeHTML(this.formatShortDateTime(executedAt, timeZone, dateFormat, timeFormat))}${timeZone ? ` (${this.escapeHTML(timeZone)})` : ''} | ${rows.length} rows</p>
  </header>

  <main>
    <section>
      <h2>Data Table</h2>
      <div class="table-container">
        ${tableHTML}
      </div>
    </section>

    ${chartHTML ? `
    <section class="page-break">
      <h2>Chart</h2>
      <div id="chart-container" class="chart-container"></div>
    </section>
    ` : ''}

    ${mapHTML ? `
    <section class="page-break">
      <h2>Location Map</h2>
      <div id="map-container" class="map-container"></div>
    </section>
    ` : ''}
  </main>

  <footer>
    <p>Exported from Dashboard Studio</p>
  </footer>

  ${chartHTML ? `<script>${chartHTML}</script>` : ''}
  ${mapHTML ? `<script>${mapHTML}</script>` : ''}
</body>
</html>`;

    logger.info('Generated HTML export', { 
      title, 
      rowCount: rows.length, 
      hasChart: !!chartHTML,
      hasMap: !!mapHTML
    });

    return html;
  }

  /**
   * Generate HTML table from data
   */
  private generateTableHTML(
    columns: ExportColumn[],
    rows: Record<string, unknown>[],
    timeZone?: string,
    dateFormat?: DateFormat,
    timeFormat?: TimeFormat,
  ): string {
    // Filter out empty columns
    const visibleColumns = this.filterEmptyColumns(columns, rows);

    const headerCells = visibleColumns.map(col => `<th>${this.escapeHTML(col.name)}</th>`).join('');

    const bodyRows = rows.slice(0, 500).map(row => {
      const cells = visibleColumns.map(col => {
        let value = row[col.name];
        if (value === null || value === undefined) {
          value = '';
        } else if (value instanceof Date) {
          value = this.formatShortDateTime(value, timeZone, dateFormat, timeFormat);
        } else if (typeof value === 'number') {
          value = this.formatNumericValue(value);
        } else if (typeof value === 'string' && /^-?\d+\.\d+0+$/.test(value)) {
          const num = parseFloat(value);
          if (!isNaN(num)) {
            value = this.formatNumericValue(num);
          }
        } else if (typeof value === 'string' && (isDateColumnByType(col) || isTimestampLikeValue(value))) {
          value = this.formatDateCell(value, timeZone, dateFormat, timeFormat) ?? value;
        } else if (typeof value === 'object') {
          value = JSON.stringify(value);
        }
        return `<td>${this.escapeHTML(String(value))}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('\n');

    const truncationNote = rows.length > 500 
      ? `<p style="margin-top: 10px; color: #666; font-size: 12px;">Showing first 500 of ${rows.length} rows. Download Excel for complete data.</p>`
      : '';

    return `<table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    ${truncationNote}`;
  }

  /**
   * Serialise a value for interpolation into an inline <script> block.
   *
   * JSON.stringify does not escape "<", so a cell containing "</script>" would
   * close the block early and let the rest of that cell parse as markup. "<"
   * only ever occurs inside a JSON string, so escaping it to < keeps the
   * output valid JSON while making the payload inert.
   */
  private jsonForScript(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  /**
   * Generate Chart.js code for time series chart
   */
  private generateChartHTML(
    columns: ExportColumn[],
    rows: Record<string, unknown>[],
    chartConfig: { type?: string; xColumn?: string; yColumns?: string[] },
    timeZone?: string,
    dateFormat?: DateFormat,
    timeFormat?: TimeFormat,
  ): string {
    const { xColumn, yColumns } = chartConfig;
    if (!xColumn || !yColumns?.length) return '';

    // Plot every row handed in: capping here would silently drop rows that the
    // exported table shows. Bounding `rows` is the caller's job.
    const xIsDate = isDateColumn(columns, xColumn, rows);
    const labels = rows.map(row => {
      const val = row[xColumn];
      if (xIsDate) {
        const text = this.formatDateCell(val, timeZone, dateFormat, timeFormat);
        if (text !== null) return text;
      }
      return String(val ?? '');
    });

    const datasets = yColumns.map((yCol, idx) => {
      const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
      const color = colors[idx % colors.length];
      const data = rows.map(row => {
        const val = row[yCol];
        return typeof val === 'number' ? val : parseFloat(String(val)) || 0;
      });
      return {
        label: yCol,
        data,
        borderColor: color,
        backgroundColor: color + '20',
        fill: true,
        tension: 0.4,
      };
    });

    // Calculate appropriate tick skip based on data size
    const maxTicks = 15;
    const skipInterval = Math.max(1, Math.ceil(labels.length / maxTicks));

    return `
      document.addEventListener('DOMContentLoaded', function() {
        const ctx = document.getElementById('chart-container');
        if (!ctx) return;
        
        const canvas = document.createElement('canvas');
        ctx.appendChild(canvas);
        
        new Chart(canvas, {
          type: 'line',
          data: {
            labels: ${this.jsonForScript(labels)},
            datasets: ${this.jsonForScript(datasets)}
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'top',
              }
            },
            scales: {
              x: {
                display: true,
                title: {
                  display: true,
                  text: ${this.jsonForScript(xColumn)}
                },
                ticks: {
                  maxRotation: 45,
                  minRotation: 20,
                  autoSkip: true,
                  maxTicksLimit: ${maxTicks},
                  callback: function(val, index) {
                    return index % ${skipInterval} === 0 ? this.getLabelForValue(val) : '';
                  }
                }
              },
              y: {
                display: true,
                beginAtZero: true
              }
            }
          }
        });
      });
    `;
  }

  /**
   * Generate Chart.js code for grouped time series chart
   */
  private generateGroupedChartHTML(
    columns: ExportColumn[],
    rows: Record<string, unknown>[],
    chartConfig: { xColumn: string; yColumn: string; groupColumn: string; groups?: string[] },
    timeZone?: string,
    dateFormat?: DateFormat,
    timeFormat?: TimeFormat,
  ): string {
    const { xColumn, yColumn, groupColumn } = chartConfig;
    if (!xColumn || !yColumn || !groupColumn) return '';

    // Get unique group values
    const groupValues = new Set<string>();
    rows.forEach(row => {
      const groupVal = row[groupColumn];
      if (groupVal !== null && groupVal !== undefined) {
        groupValues.add(String(groupVal));
      }
    });

    // Plot the series the request picked, keeping its order: that order assigned
    // the colours on screen. Picks the re-query no longer returns drop out
    // instead of becoming empty legend entries. With no usable list — an older
    // client, or every pick stranded — fall back to the first groups, as
    // resolvePlottedGroups does on the frontend for those same cases. The list
    // comes straight off the request body, so it is not trusted to be an array.
    const requestedGroups = Array.isArray(chartConfig.groups)
      ? chartConfig.groups.filter(group => groupValues.has(group))
      : [];
    const groups = requestedGroups.length > 0
      ? requestedGroups
      : Array.from(groupValues).slice(0, DEFAULT_GROUP_LIMIT);

    // Sort rows by X value. No row cap: capping here would drop points that the
    // on-screen chart plots, and would strand groups whose rows all sort past
    // the cut with empty datasets (`groups` is derived from every row).
    const sortedRows = [...rows].sort((a, b) => {
      const aVal = a[xColumn];
      const bVal = b[xColumn];
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    });

    const xIsDate = isDateColumn(columns, xColumn, rows);
    const xValuesSet = new Set<string>();
    sortedRows.forEach(row => {
      const val = row[xColumn];
      if (val !== null && val !== undefined) {
        if (xIsDate) {
          xValuesSet.add(
            this.formatDateCell(val, timeZone, dateFormat, timeFormat) ?? String(val),
          );
        } else {
          xValuesSet.add(String(val));
        }
      }
    });
    const labels = Array.from(xValuesSet);

    // Create datasets for each group. Same palette in the same order as
    // CHART_COLORS in src/pages/CompositeReportView.tsx: a series takes its
    // colour from its position, so the two lists have to stay in step.
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899'];
    const datasets = groups.map((group, idx) => {
      const color = colors[idx % colors.length];
      const groupRows = sortedRows.filter(row => String(row[groupColumn] ?? 'Unknown') === group);

      // Map X values to Y values for this group
      const dataMap = new Map<string, number>();
      groupRows.forEach(row => {
        const xVal = row[xColumn];
        let label: string;
        if (xIsDate) {
          label = this.formatDateCell(xVal, timeZone, dateFormat, timeFormat) ?? String(xVal ?? '');
        } else {
          label = String(xVal ?? '');
        }
        const yVal = row[yColumn];
        const numVal = typeof yVal === 'number' ? yVal : parseFloat(String(yVal)) || 0;
        dataMap.set(label, numVal);
      });
      
      const data = labels.map(label => dataMap.get(label) ?? null);
      
      return {
        label: group,
        data,
        borderColor: color,
        backgroundColor: color + '20',
        fill: false,
        tension: 0.1,
        spanGaps: true,
      };
    });

    // Calculate appropriate tick skip based on data size
    const maxTicks = 15;
    const skipInterval = Math.max(1, Math.ceil(labels.length / maxTicks));

    return `
      document.addEventListener('DOMContentLoaded', function() {
        const ctx = document.getElementById('chart-container');
        if (!ctx) return;
        
        const canvas = document.createElement('canvas');
        ctx.appendChild(canvas);
        
        new Chart(canvas, {
          type: 'line',
          data: {
            labels: ${this.jsonForScript(labels)},
            datasets: ${this.jsonForScript(datasets)}
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
              }
            },
            scales: {
              x: {
                display: true,
                title: {
                  display: true,
                  text: ${this.jsonForScript(xColumn)}
                },
                ticks: {
                  maxRotation: 45,
                  minRotation: 20,
                  autoSkip: true,
                  maxTicksLimit: ${maxTicks},
                  callback: function(val, index) {
                    return index % ${skipInterval} === 0 ? this.getLabelForValue(val) : '';
                  }
                }
              },
              y: {
                display: true,
                beginAtZero: true,
                title: {
                  display: true,
                  text: ${this.jsonForScript(yColumn)}
                }
              }
            }
          }
        });
      });
    `;
  }

  /**
   * Generate Leaflet map code
   */
  private generateMapHTML(
    rows: Record<string, unknown>[],
    gpsColumns: { latColumn: string; lonColumn: string },
    mapSettings?: { center: [number, number]; zoom: number }
  ): string {
    // Extract valid GPS points. The (0,0) null-island filter keeps the export's
    // fitBounds framed on the same real markers the live map shows (FR-11283).
    const points = rows
      .filter(row => {
        const lat = parseFloat(String(row[gpsColumns.latColumn]));
        const lon = parseFloat(String(row[gpsColumns.lonColumn]));
        return isDisplayableCoordinate(lat, lon);
      })
      .slice(0, 500) // Limit markers for performance
      .map(row => ({
        lat: parseFloat(String(row[gpsColumns.latColumn])),
        lon: parseFloat(String(row[gpsColumns.lonColumn])),
      }));

    if (points.length === 0) return '';

    // Use mapSettings from frontend if provided, otherwise calculate default
    let centerLat: number;
    let centerLon: number;
    let zoom: number;

    if (mapSettings) {
      // Use the exact view state from the frontend
      centerLat = mapSettings.center[0];
      centerLon = mapSettings.center[1];
      zoom = mapSettings.zoom;
    } else {
      // Calculate center from points
      centerLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
      centerLon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
      zoom = 10;
    }

    // If mapSettings provided, don't auto-fit bounds - use exact view
    const fitBoundsCode = mapSettings ? '' : `
        if (markers.length > 1) {
          const group = L.featureGroup(markers);
          map.fitBounds(group.getBounds().pad(0.1));
        }`;

    return `
      document.addEventListener('DOMContentLoaded', function() {
        const container = document.getElementById('map-container');
        if (!container) return;
        
        const map = L.map(container, { attributionControl: false }).setView([${centerLat}, ${centerLon}], ${zoom});
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
        
        // Add Navixy logo in bottom right
        const navixyControl = L.control({ position: 'bottomright' });
        navixyControl.onAdd = function() {
          const div = L.DomUtil.create('div', 'navixy-attribution');
          div.innerHTML = '<a href="https://www.navixy.com" target="_blank" rel="noopener noreferrer" title="Powered by Navixy" style="display:block"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_navixy)"><path d="M9.92784 0.0618557C4.26804 1.05155 0.0927835 5.96907 0 11.7217V12.3402L10.3608 6.15464V0L9.92784 0.0618557Z" fill="#007AD2"/><path d="M24.064 11.8763C24.033 6.06186 19.8578 1.08247 14.1361 0.0618557L13.7031 0V6.21649L24.064 12.4948V11.8763Z" fill="#007AD2"/><path d="M0.772149 16.1754C1.63813 18.4331 3.12266 20.3816 5.10205 21.7733C7.14328 23.196 9.52473 23.9692 12.0299 23.9692C14.5041 23.9692 16.8855 23.227 18.8959 21.8043C20.8752 20.4434 22.3598 18.5259 23.2258 16.2991L23.3185 16.0208L11.999 9.15479L0.648438 15.928L0.772149 16.1754Z" fill="#007AD2"/></g><defs><clipPath id="clip0_navixy"><rect width="24" height="24" fill="white"/></clipPath></defs></svg></a>';
          div.style.background = 'rgba(255,255,255,0.8)';
          div.style.padding = '2px 4px';
          div.style.borderRadius = '4px';
          return div;
        };
        navixyControl.addTo(map);
        
        const points = ${JSON.stringify(points)};
        const markers = [];
        
        points.forEach(function(point) {
          const marker = L.marker([point.lat, point.lon]).addTo(map);
          markers.push(marker);
        });
        ${fitBoundsCode}
      });
    `;
  }

  /**
   * Get Chart.js library script tag
   */
  private getChartLibraryScript(): string {
    return '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>';
  }

  /**
   * Get Leaflet library script and style tags
   */
  private getMapLibraryScript(): string {
    return `
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    `;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHTML(str: string): string {
    const escapeMap: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return str.replace(/[&<>"']/g, char => escapeMap[char] ?? char);
  }

  /**
   * Generate PDF from HTML content using Puppeteer
   */
  async generatePDF(html: string): Promise<Buffer> {
    // Dynamic import to avoid loading puppeteer when not needed
    const puppeteer = await import('puppeteer');
    
    let browser = null;
    try {
      // Use system Chromium if available (Docker), otherwise use bundled
      const launchOptions: Parameters<typeof puppeteer.default.launch>[0] = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      };
      
      // Only set executablePath if defined (for Docker with system Chromium)
      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }
      
      browser = await puppeteer.default.launch(launchOptions);
      
      const page = await browser.newPage();
      
      // Set content and wait for resources to load
      await page.setContent(html, {
        waitUntil: ['networkidle0', 'domcontentloaded'],
        timeout: 30000,
      });
      
      // Wait a bit for any charts/scripts to render
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
      
      // Generate PDF
      const pdfBuffer = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: {
          top: '15mm',
          right: '10mm',
          bottom: '15mm',
          left: '10mm',
        },
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="font-size: 10px; color: #666; width: 100%; text-align: center; padding: 10px 0;">
            Page <span class="pageNumber"></span> of <span class="totalPages"></span>
          </div>
        `,
      });
      
      return Buffer.from(pdfBuffer);
    } catch (error) {
      logger.error('PDF generation failed:', error);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}

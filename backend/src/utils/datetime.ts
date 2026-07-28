/**
 * Date/timestamp helpers for the export pipeline.
 *
 * These mirror the frontend's `src/utils/datetime.ts` (`isTimestampLike`,
 * `parseServerTimestamp`) so exports format date-like values exactly the way
 * the Data Table renders them on screen — see FR-11265. Kept as a small, pure
 * module (no imports) so the regex/parsing logic is unit-testable in isolation,
 * without pulling in ExcelJS/puppeteer via the export service.
 */

// Matches ISO-ish timestamps: "2026-05-20", "2026-05-20 01:02:25",
// "2026-05-20T01:02:25Z", "2026-05-20T01:02:25.123+02:00", etc.
// Mirrors the frontend's `isTimestampLike` regex.
export const TIMESTAMP_LIKE_RE =
  /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const TIMEZONE_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

// A calendar day with no clock: a `date` column (kept as Postgres' own string
// by pgTypeParsers) or a `::date` / `to_char` rollup.
export const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/**
 * Read a bare "YYYY-MM-DD" as the calendar fields it is, or null for anything
 * else.
 *
 * Callers format those fields directly instead of going through a Date: a day
 * has no instant behind it, so parsing it (as UTC midnight) and rendering it in
 * the export's timezone would move it to the previous day for every zone west
 * of UTC and add a clock the query never returned — the same rule the frontend
 * applies in `formatTimestamp` (DO-273).
 */
export function parseCalendarDay(value: unknown): CalendarDay | null {
  if (typeof value !== 'string') return null;
  const match = DATE_ONLY_RE.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * True for values that look like an ISO date/timestamp string. Non-strings
 * (numbers, Dates, objects, null) return false.
 */
export function isTimestampLikeValue(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_LIKE_RE.test(value.trim());
}

/**
 * Validate an untrusted request value as an IANA timezone name.
 *
 * Returns the trimmed name when Intl can construct a formatter for it, and
 * undefined otherwise — callers treat "no zone" as "keep the session default",
 * so an invalid preference degrades to the pre-DO-352 behaviour instead of
 * failing the query. The length cap bounds what we hand to Intl; real IANA
 * names top out around 30 characters ("America/Argentina/ComodRivadavia").
 *
 * Intl accepting a name does not guarantee the Postgres server's tzdata knows
 * it (the two ship separately); DatabaseService applies it via a bound
 * set_config() and falls back to the session default if the server rejects it.
 *
 * Bare offsets ("+05:00") are rejected even though Intl accepts them: Postgres
 * reads offset strings with the POSIX sign convention (positive = west of
 * Greenwich), the opposite of ISO, so passing one through would silently
 * invert the viewer's clock. Named zones — including the genuinely
 * POSIX-signed Etc/GMT+2 family — are unaffected.
 */
export function sanitizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: trimmed });
    return trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Parse a timestamp string to a Date, mirroring the frontend's
 * `parseServerTimestamp`. ISO-shaped strings without a TZ suffix are treated as
 * UTC (we append `Z`); strings that don't match the ISO shape fall back to the
 * engine's `Date` parser so non-ISO formats are handled the same way the Data
 * Table does on screen.
 */
export function parseTimestampValue(raw: string): Date | null {
  if (raw.length === 0) return null;
  const trimmed = raw.trim();
  if (!TIMESTAMP_LIKE_RE.test(trimmed)) {
    const fallback = new Date(trimmed);
    return isNaN(fallback.getTime()) ? null : fallback;
  }
  const normalised = TIMEZONE_SUFFIX_RE.test(trimmed)
    ? trimmed.replace(' ', 'T')
    : `${trimmed.replace(' ', 'T')}Z`;
  const d = new Date(normalised);
  return isNaN(d.getTime()) ? null : d;
}
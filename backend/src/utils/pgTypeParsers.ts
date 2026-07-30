import { types } from 'pg';

/**
 * Postgres `date` (OID 1082) — a calendar day, with no clock and no zone.
 *
 * node-postgres parses it with `new Date(year, month - 1, day)`, i.e. midnight
 * in *the backend process's* zone, and Express then serialises that Date to an
 * instant: on a server in Europe/Belgrade the day `2026-05-12` leaves the API
 * as `"2026-05-11T22:00:00.000Z"`. Every consumer downstream — chart axis,
 * table cell, export — reads that as a moment and renders it in the viewer's
 * zone, so a viewer west of the server sees the day before, plus a clock the
 * query never returned (DO-273).
 *
 * The text Postgres sent is already the right answer, so we keep it. A day
 * stays `"2026-05-12"` end to end, identical for every backend zone, and the
 * display layer formats it as a day (`formatTimestamp` / the export pipeline's
 * date-only branch) instead of converting it.
 *
 * Scope is deliberately just this OID: `timestamptz` (1184) carries an offset
 * and round-trips correctly as a Date, and changing naive `timestamp` (1114)
 * would move a convention DO-352 settled, so it stays as it is.
 */
export const DATE_OID = 1082;

let configured = false;

/**
 * Register the parsers. Idempotent, and safe to call before any pool exists —
 * `pg.types` is module-global, so this applies to every pool the process opens,
 * including the per-user external pools.
 */
export function configurePgTypeParsers(): void {
  if (configured) return;
  configured = true;
  types.setTypeParser(DATE_OID, (value: string) => value);
}

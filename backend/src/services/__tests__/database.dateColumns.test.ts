import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { types } from 'pg';
// Importing the service applies the type-parser configuration, exactly as it is
// applied in the running process — these tests assert the boundary behaviour it
// produces, not a re-implementation of it.
import { DatabaseService } from '../database.js';
import { DATE_OID } from '../../utils/pgTypeParsers.js';

/**
 * DO-273: a Postgres `date` is a calendar day. node-postgres parses it with
 * `new Date(y, m - 1, d)` — midnight in *the backend's* zone — and JSON turns
 * that into an instant, so `2026-05-12` leaves a Belgrade server as
 * `"2026-05-11T22:00:00.000Z"` and every viewer west of the server renders the
 * day before, with a clock the query never returned.
 *
 * These cover the pg → API half of that path (`Postgres date → API JSON`); the
 * API → label half is `formatTimestamp` / `formatChartAxisLabel` in
 * src/utils/__tests__/datetime.test.ts, which takes the value asserted here as
 * its input.
 */

const IOT_DB_URL = 'postgresql://user:pw@example.test:5432/db';
const DAY_TEXT = '2026-05-12';

/**
 * What node-postgres' *default* parser makes of a `date`, in a server running
 * in `timeZone`, serialised the way the API would send it.
 *
 * In a child process because the zone has to be set before the runtime reads
 * it: assigning `process.env.TZ` inside Jest does not reach V8's cached local
 * zone, so an in-process "loop over zones" would silently test one zone three
 * times.
 */
function defaultParserInZone(timeZone: string): string {
  const script = "const { getTypeParser } = require('pg-types');"
    + "process.stdout.write(JSON.stringify(getTypeParser(1082, 'text')(process.argv[1])));";
  return execFileSync(process.execPath, ['-e', script, DAY_TEXT], {
    env: { ...process.env, TZ: timeZone },
    encoding: 'utf8',
  });
}

function makeDateClient() {
  const client = {
    query: async (arg: string | { text?: string; rowMode?: string }) => {
      const text = typeof arg === 'string' ? arg : arg.text ?? '';
      if (text.includes('set_config') || text.startsWith('SET ')) {
        return { rows: [], fields: [] };
      }
      // What the driver hands back for `SELECT ts::date AS day, count(*) …`,
      // through the parser this process actually registered.
      const parsed = types.getTypeParser(DATE_OID, 'text')(DAY_TEXT);
      return {
        rows: [[parsed, 7]],
        fields: [
          { name: 'day', dataTypeID: DATE_OID },
          { name: 'total', dataTypeID: 23 },
        ],
      };
    },
    release: () => undefined,
  };
  return client;
}

type PoolSeam = {
  getExternalDatabaseConfig: (url: string) => Promise<unknown>;
  getExternalPool: (config: unknown) => Promise<unknown>;
};

describe('Postgres date (OID 1082) → API JSON', () => {
  it('keeps the calendar string Postgres sent', () => {
    const parsed = types.getTypeParser(DATE_OID, 'text')(DAY_TEXT);
    expect(parsed).toBe(DAY_TEXT);
    // And survives serialisation as the same day — a Date would not.
    expect(JSON.parse(JSON.stringify({ d: parsed })).d).toBe(DAY_TEXT);
  });

  it('no longer depends on where the backend runs', () => {
    // The hazard this replaces: pg's own parser builds midnight in the server's
    // zone, so one day leaves the API as three different instants — two of them
    // a different day once the viewer's zone is applied on top.
    expect(defaultParserInZone('Europe/Belgrade')).toBe('"2026-05-11T22:00:00.000Z"');
    expect(defaultParserInZone('UTC')).toBe('"2026-05-12T00:00:00.000Z"');
    expect(defaultParserInZone('Pacific/Auckland')).toBe('"2026-05-11T12:00:00.000Z"');
  });

  it('reaches the API response as a bare day', async () => {
    const service = new DatabaseService();
    const seam = service as unknown as PoolSeam;
    seam.getExternalDatabaseConfig = async () => ({});
    seam.getExternalPool = async () => ({ connect: async () => makeDateClient() });

    const result = await service.executeParameterizedQuery(
      'SELECT ts::date AS day, count(*) AS total FROM readings GROUP BY 1',
      {}, 12345, 100, IOT_DB_URL, undefined, 'America/New_York',
    );

    expect(result.columns).toEqual([
      { name: 'day', type: 'date' },
      { name: 'total', type: 'integer' },
    ]);
    // Serialised, because that is what the panel actually receives.
    const wire = JSON.parse(JSON.stringify(result)) as { rows: unknown[][] };
    expect(wire.rows[0]![0]).toBe(DAY_TEXT);
  });
});

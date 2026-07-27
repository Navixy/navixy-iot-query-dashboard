/**
 * The demo write guard is only worth anything if EVERY tenant-database write
 * carries it (review !62 round 10, Critical 2). A per-route middleware is
 * fail-OPEN by nature — forget it on one new route and the demo promise leaks
 * there silently — so this asserts the guard is mounted on every mutating route,
 * with the exceptions written down as data rather than left implicit.
 *
 * SOURCE-LEVEL, not by importing the routers: app.ts pulls in DatabaseService
 * and through it sqlSelectGuard's `createRequire(import.meta.url)`, which this
 * repo's ts-jest ESM setup cannot load. Reading the route declarations is the
 * same assertion without that import graph.
 *
 * A blanket "no non-GET for demo" rule is NOT the answer and must not replace
 * this: demo users legitimately POST to the read-only SQL execution, panel
 * export and composite-report execute/export/geocode endpoints. The distinction
 * is "writes to the tenant settings DB", which only the route list knows.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// From the jest rootDir (backend/), not import.meta — ts-jest compiles this
// suite to CJS, where import.meta is a syntax error.
const routesDir = join(process.cwd(), 'src', 'routes');

/** Mutating routes that must stay reachable for a demo session, with the why. */
const ALLOWED_WITHOUT_GUARD = new Set([
  // Deleting the temporary demo user is part of the demo sign-in flow itself:
  // the frontend seeds IndexedDB and then removes the throwaway row it created.
  "delete /auth/demo-user",
  // Not a tenant-database write: runs a connectivity probe against iotDbUrl.
  "post /auth/test-iot-connection",
  // Login mints the token; the request is not authenticated yet, so there is no
  // demo flag to test.
  "post /auth/login",
  // Execution / export / geocoding read and render; none writes the tenant's
  // settings schema.
  "post /composite-reports/:id/execute",
  "post /composite-reports/:id/detect-columns",
  "post /composite-reports/:id/export/excel",
  "post /composite-reports/:id/export/html",
  "post /composite-reports/:id/export/pdf",
  "post /composite-reports/geocode",
  "post /composite-reports/geocode-batch",
  "post /composite-reports/geocode-cache/clear",
]);

interface Declared {
  id: string;
  guarded: boolean;
}

/** Every `router.<method>('<path>', <middleware chain>` declaration in a file. */
function declaredMutatingRoutes(file: string): Declared[] {
  const source = readFileSync(join(routesDir, file), 'utf8');
  const out: Declared[] = [];
  const re = /router\.(post|put|patch|delete)\(\s*'([^']+)'([^\n]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push({
      id: `${match[1]} ${match[2]}`,
      guarded: match[3].includes('rejectDemoWrites'),
    });
  }
  return out;
}

const FILES = ['app.ts', 'menu.ts', 'composite-reports.ts'];

describe('every mutating route carries the demo write guard', () => {
  it.each(FILES)('%s', (file) => {
    const unguarded = declaredMutatingRoutes(file)
      .filter((r) => !r.guarded && !ALLOWED_WITHOUT_GUARD.has(r.id))
      .map((r) => r.id);

    // A new write route that forgets rejectDemoWrites fails HERE, by name.
    expect(unguarded).toEqual([]);
  });

  it('actually finds routes to check (a broken matcher would pass vacuously)', () => {
    const guarded = FILES.flatMap(declaredMutatingRoutes).filter((r) => r.guarded);
    expect(guarded.length).toBeGreaterThanOrEqual(22);
  });
});

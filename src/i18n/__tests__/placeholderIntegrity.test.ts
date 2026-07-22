import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Non-English translations are produced from the English source. A translated
// value must use exactly the same {placeholder} set as its English source — a
// dropped or renamed placeholder means an interpolated value (a count, name,
// date) renders as a literal "{count}" in that language. This test fails
// before such a file is merged.
//
// Layout is folder-per-locale, file-per-module: src/locales/<locale>/<module>.json.
const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');
const EN_DIR = join(LOCALES_DIR, 'en_US');

function collectPlaceholders(obj: unknown, path: string, acc: Map<string, Set<string>>): void {
  if (typeof obj === 'string') {
    const names = new Set<string>();
    for (const m of obj.matchAll(/\{(\w+)\}/g)) names.add(m[1]);
    acc.set(path, names);
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      collectPlaceholders(v, path ? `${path}.${k}` : k, acc);
    }
  }
}

function placeholdersForModule(dir: string, moduleFile: string): Map<string, Set<string>> {
  const acc = new Map<string, Set<string>>();
  const full = join(dir, moduleFile);
  if (!existsSync(full)) return acc;
  collectPlaceholders(JSON.parse(readFileSync(full, 'utf8')), '', acc);
  return acc;
}

const enModules = readdirSync(EN_DIR).filter((f) => f.endsWith('.json'));
const localeDirs = readdirSync(LOCALES_DIR).filter(
  (d) => d !== 'en_US' && statSync(join(LOCALES_DIR, d)).isDirectory(),
);

describe('placeholder integrity across locales', () => {
  if (localeDirs.length === 0) {
    it('no translation folders yet (none added)', () => {
      expect(true).toBe(true);
    });
  }

  for (const locale of localeDirs) {
    for (const moduleFile of enModules) {
      it(`${locale}/${moduleFile} matches en_US placeholders`, () => {
        const en = placeholdersForModule(EN_DIR, moduleFile);
        const loc = placeholdersForModule(join(LOCALES_DIR, locale), moduleFile);

        const mismatches: string[] = [];
        for (const [keyPath, names] of loc) {
          const expected = en.get(keyPath);
          if (!expected) continue; // key absent from English is ignored (stale)
          for (const name of names) {
            if (!expected.has(name)) mismatches.push(`${keyPath}: unexpected {${name}}`);
          }
          for (const name of expected) {
            if (!names.has(name)) mismatches.push(`${keyPath}: missing {${name}}`);
          }
        }

        expect(mismatches).toEqual([]);
      });
    }
  }
});

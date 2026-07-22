import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static t('...') keys used in code must resolve to a string in the English
// source, otherwise the UI renders the raw key path. Dynamic keys built from
// template literals (e.g. t(`common.roles.${role}`)) are not covered here.
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EN_DIR = join(SRC_ROOT, 'locales', 'en_US');

// Assemble the English bundle from the per-module files (folder per locale),
// keying each module under its filename — the same shape the runtime builds.
const en_US: Record<string, unknown> = {};
for (const file of readdirSync(EN_DIR)) {
  if (!file.endsWith('.json')) continue;
  en_US[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(EN_DIR, file), 'utf8'));
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      collectSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

describe('t() keys referenced in src/ exist in the English source', () => {
  it('finds no unresolved static keys', () => {
    const keyPattern = /\bt\(\s*['"]([a-z0-9_]+(?:\.[a-z0-9_]+)+)['"]/g;
    const missing: string[] = [];

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(keyPattern)) {
        const key = match[1];
        if (typeof getByPath(en_US, key) !== 'string') {
          missing.push(`${file}: ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

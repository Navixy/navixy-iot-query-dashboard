// A real (in-memory) IndexedDB so Dexie runs exactly as it does in the browser,
// including transaction serialization on overlapping stores — the property the
// in-transaction identity guard relies on.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { demoStorageService } from '@/services/demoStorage';

const seed = (userId: string) => ({
  sections: [{ id: `sec-${userId}`, name: `Section ${userId}`, user_id: userId }],
  reports: [],
  globalVariables: [],
  chartCatalog: null,
  userId,
});

beforeEach(async () => {
  // Fresh store each test: no predicate → a real clear.
  await demoStorageService.clearAllData();
});

/**
 * review !62 round 5, Critical 2. Before the fix, clearAllData/seedFromBackend
 * had NO identity guard at all — it lived only in AuthContext BEFORE the call,
 * leaving the awaits inside these operations as an interleaving window. These
 * pin the guard INSIDE the destructive operations: a superseded run (shouldAbort
 * → true) must leave the current identity's singleton store untouched.
 */
describe('demoStorage identity guard', () => {
  it('clearAllData(shouldAbort→true) leaves the current identity data intact', async () => {
    await demoStorageService.seedFromBackend(seed('A'));
    expect(await demoStorageService.isSeeded()).toBe(true);

    // A run whose identity was superseded while it awaited must NOT wipe the store.
    await demoStorageService.clearAllData(() => true);

    expect(await demoStorageService.isSeeded()).toBe(true);
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });

  it('clearAllData() with no predicate still clears (normal path unaffected)', async () => {
    await demoStorageService.seedFromBackend(seed('A'));
    await demoStorageService.clearAllData();
    expect(await demoStorageService.isSeeded()).toBe(false);
    expect(await demoStorageService.getSections()).toEqual([]);
  });

  it('seedFromBackend(..., shouldAbort→true) neither wipes nor replaces the current identity data', async () => {
    await demoStorageService.seedFromBackend(seed('A'));

    // A superseded seed of B's data (its internal clear AND its write both abort).
    await demoStorageService.seedFromBackend(seed('B'), () => true);

    // A survived; B was never written.
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });

  it('seedFromBackend(..., shouldAbort→false) seeds normally', async () => {
    await demoStorageService.seedFromBackend(seed('A'), () => false);
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });
});

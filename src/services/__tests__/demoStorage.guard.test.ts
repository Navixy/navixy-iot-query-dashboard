// A real (in-memory) IndexedDB so Dexie runs exactly as it does in the browser,
// including transaction serialization on overlapping stores — the property the
// in-transaction ownership guard relies on.
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
  // Fresh data each test: no expected owner → an unconditional clear.
  await demoStorageService.clearAllData();
});

/**
 * review !62 round 7, finding 1. Round 6 guarded these destructive ops with a
 * TAB-LOCAL React ref, so a concurrent demo sign-in in ANOTHER tab could not be
 * seen as stale and its late seed clobbered the singleton store. The guard is now
 * an ORIGIN-WIDE token stored in IndexedDB and re-read INSIDE each destructive
 * transaction. These pin that a run whose ownership moved on aborts (returns
 * false) and leaves the successor's store untouched — and that the abort is
 * observable to the caller.
 */
describe('demoStorage origin-wide ownership guard', () => {
  it('a clear whose ownership moved on aborts and leaves the current data intact', async () => {
    const a = await demoStorageService.claimDemoOwnership();
    await demoStorageService.seedFromBackend(seed('A'), a);
    expect(await demoStorageService.isSeeded()).toBe(true);

    // Another sign-in (any tab) claims a new token — 'a' is now stale.
    await demoStorageService.claimDemoOwnership();

    // The stale clear aborts and does NOT wipe the store.
    expect(await demoStorageService.clearAllData(a)).toBe(false);
    expect(await demoStorageService.isSeeded()).toBe(true);
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });

  it('a clear with the CURRENT owner runs and returns true', async () => {
    const a = await demoStorageService.claimDemoOwnership();
    await demoStorageService.seedFromBackend(seed('A'), a);
    expect(await demoStorageService.clearAllData(a)).toBe(true);
    expect(await demoStorageService.isSeeded()).toBe(false);
  });

  it('clearAllData() with no expected owner still clears (legacy path)', async () => {
    const a = await demoStorageService.claimDemoOwnership();
    await demoStorageService.seedFromBackend(seed('A'), a);
    expect(await demoStorageService.clearAllData()).toBe(true);
    expect(await demoStorageService.isSeeded()).toBe(false);
    expect(await demoStorageService.getSections()).toEqual([]);
  });

  it('a seed whose ownership moved on neither wipes nor replaces the current data', async () => {
    const a = await demoStorageService.claimDemoOwnership();
    await demoStorageService.seedFromBackend(seed('A'), a);

    // B claims, then C claims — B's token is now stale.
    const b = await demoStorageService.claimDemoOwnership();
    await demoStorageService.claimDemoOwnership();

    // B's superseded seed aborts (its internal clear AND its write both abort).
    expect(await demoStorageService.seedFromBackend(seed('B'), b)).toBe(false);

    // A survived; B was never written.
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });

  it('a seed with the CURRENT owner seeds normally and returns true', async () => {
    const owner = await demoStorageService.claimDemoOwnership();
    expect(await demoStorageService.seedFromBackend(seed('A'), owner)).toBe(true);
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });

  it('readDemoOwner reflects the latest claim', async () => {
    const a = await demoStorageService.claimDemoOwnership();
    expect(await demoStorageService.readDemoOwner()).toBe(a);
    const b = await demoStorageService.claimDemoOwnership();
    expect(await demoStorageService.readDemoOwner()).toBe(b);
    expect(b).not.toBe(a);
  });
});

// A real (in-memory) IndexedDB so Dexie runs exactly as it does in the browser,
// including transaction serialization on overlapping stores — the property the
// in-transaction ownership guard relies on.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import Dexie from 'dexie';
import { demoStorageService } from '@/services/demoStorage';
import {
  anchorDemoOwnership,
  resetDemoOwnershipToPageLoad,
  revokeDemoOwnership,
} from '@/lib/authSession';

const seed = (userId: string) => ({
  sections: [{ id: `sec-${userId}`, name: `Section ${userId}`, user_id: userId }],
  reports: [],
  globalVariables: [],
  chartCatalog: null,
  userId,
});

/** Drop the owner row through a SECOND handle on the same database — clearAllData
 *  deliberately preserves it, and this is the only faithful way to reproduce a
 *  store seeded before round 7 introduced the row. */
async function emptyOwnerRow(): Promise<void> {
  const raw = new Dexie('NavixyDemoDatabase');
  raw.version(3).stores({
    sections: 'id, name, sortOrder, userId, isDeleted',
    reports: 'id, title, sectionId, sortOrder, userId, isDeleted',
    globalVariables: 'id, label',
    metadata: 'id, key',
    chartCatalog: 'id',
    owner: 'id',
  });
  await raw.open();
  await raw.table('owner').clear();
  raw.close();
}

beforeEach(async () => {
  // Page-load state ('unclaimed'): this tab has never held a demo session. NOT
  // the same as having lost one — see the round-10 describe at the bottom.
  resetDemoOwnershipToPageLoad();
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
    // Reads are guarded too since round 10, so adopt the CURRENT owner to look.
    anchorDemoOwnership((await demoStorageService.readDemoOwner())!);
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
    anchorDemoOwnership((await demoStorageService.readDemoOwner())!);
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });

  it('a seed with the CURRENT owner seeds normally and returns true', async () => {
    const owner = await demoStorageService.claimDemoOwnership();
    anchorDemoOwnership(owner);
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

/**
 * review !62 round 9, finding 2. Rounds 7-8 guarded only the DESTRUCTIVE entry
 * points (clear/seed), so ordinary CRUD — the whole of demo mode's day-to-day
 * traffic — could still read and write the singleton store on behalf of a tab
 * whose identity had been superseded: an in-flight or not-yet-torn-down tab
 * editing the SUCCESSOR's reports, or rendering them. Every operation now
 * asserts the token THIS TAB claimed, with the check for writes made INSIDE the
 * same transaction as the write so a claim cannot interleave between them.
 *
 * The rule is deny-on-PROVEN-supersession, not deny-unless-proven-ownership: a
 * tab holding no anchor at all (a legacy store predating the owner row, or the
 * bootstrap window before AuthContext restores a session) keeps the previous
 * unconditional behaviour rather than the app bricking itself.
 */
describe('demoStorage per-operation ownership assertion (round 9, finding 2)', () => {
  const supersededTab = async () => {
    const mine = await demoStorageService.claimDemoOwnership();
    anchorDemoOwnership(mine); // this tab anchors to its own claim
    await demoStorageService.seedFromBackend(seed('A'), mine);
    await demoStorageService.claimDemoOwnership(); // another sign-in takes over
  };

  it('a superseded tab cannot CREATE into the successor\'s store', async () => {
    await supersededTab();
    await expect(
      demoStorageService.createSection({ name: 'stale', userId: 'A' }),
    ).rejects.toThrow(/newer sign-in/i);
    // Nothing was written on top of the successor's data.
    resetDemoOwnershipToPageLoad();
    await demoStorageService.claimDemoOwnership().then(anchorDemoOwnership);
    expect((await demoStorageService.getSections()).map((s) => s.id)).toEqual(['sec-A']);
  });

  it('a superseded tab cannot UPDATE or DELETE the successor\'s rows', async () => {
    await supersededTab();
    await expect(
      demoStorageService.updateSection('sec-A', { name: 'renamed', userId: 'A', version: 1 }),
    ).rejects.toThrow(/newer sign-in/i);
    await expect(
      demoStorageService.deleteSection('sec-A', 'delete_children', 'A'),
    ).rejects.toThrow(/newer sign-in/i);

    await demoStorageService.claimDemoOwnership().then(anchorDemoOwnership);
    const sections = await demoStorageService.getSections();
    expect(sections.map((s) => s.name)).toEqual(['Section A']); // untouched
  });

  it('a superseded tab cannot create/update/delete REPORTS or GLOBAL VARIABLES', async () => {
    await supersededTab();
    await expect(
      demoStorageService.createReport({ title: 'stale', reportSchema: {}, userId: 'A' }),
    ).rejects.toThrow(/newer sign-in/i);
    await expect(
      demoStorageService.createGlobalVariable({ label: 'stale' }),
    ).rejects.toThrow(/newer sign-in/i);

    await demoStorageService.claimDemoOwnership().then(anchorDemoOwnership);
    expect(await demoStorageService.getReports()).toEqual([]);
    expect(await demoStorageService.getGlobalVariables()).toEqual([]);
  });

  it('a superseded tab READS nothing — the successor\'s data never crosses identities', async () => {
    await supersededTab();
    expect(await demoStorageService.getSections()).toEqual([]);
    expect(await demoStorageService.getReports()).toEqual([]);
    expect(await demoStorageService.getGlobalVariables()).toEqual([]);
    expect(await demoStorageService.getReportById('sec-A')).toBeNull();
    expect(await demoStorageService.getChartCatalog()).toBeNull();
    const tree = await demoStorageService.getMenuTree('A');
    expect(tree.sections).toEqual([]);
    expect(tree.rootReports).toEqual([]);
  });

  it('the CURRENT owner reads and writes normally', async () => {
    const mine = await demoStorageService.claimDemoOwnership();
    anchorDemoOwnership(mine);
    await demoStorageService.seedFromBackend(seed('A'), mine);

    const created = await demoStorageService.createSection({ name: 'mine', userId: 'A' });
    expect(created.name).toBe('mine');
    expect((await demoStorageService.getSections()).map((s) => s.name).sort()).toEqual([
      'Section A',
      'mine',
    ]);
  });

});

/**
 * review !62 round 10, Critical 1. Round 9 modelled the anchor as `string | null`
 * and read null as PERMISSION — "no claim to compare, so nothing to supersede".
 * That was wrong in the one case it exists for: the cross-tab teardown CLEARS the
 * anchor, so a superseded tab's in-flight operation arrived holding null and was
 * waved through into the successor's freshly-seeded store. The round-9 test named
 * "a tab with NO anchor keeps the unconditional legacy behaviour" pinned exactly
 * that unsafe path and is REPLACED by the three cases below.
 */
describe('demo ownership is a tri-state, and only two of them may act', () => {
  it('REVOKED is denied — a teardown must not read as "no claim, carry on"', async () => {
    const mine = await demoStorageService.claimDemoOwnership();
    anchorDemoOwnership(mine);
    await demoStorageService.seedFromBackend(seed('A'), mine);

    // What endAuthSession does when the cross-tab ender fires. An operation
    // already in flight reaches the guard AFTER this point.
    revokeDemoOwnership();

    await expect(
      demoStorageService.createSection({ name: 'in flight at teardown', userId: 'A' }),
    ).rejects.toThrow(/newer sign-in/i);
    expect(await demoStorageService.getSections()).toEqual([]);

    // ...and it stays denied even though this tab was the LAST owner: it gave the
    // claim up, so the store is no longer its to touch.
    expect(await demoStorageService.readDemoOwner()).toBe(mine);
  });

  it('UNCLAIMED is denied while the store HAS an owner — it is somebody else\'s', async () => {
    const other = await demoStorageService.claimDemoOwnership();
    await demoStorageService.seedFromBackend(seed('A'), other);
    resetDemoOwnershipToPageLoad();

    await expect(
      demoStorageService.createSection({ name: 'no claim', userId: 'A' }),
    ).rejects.toThrow(/newer sign-in/i);
    expect(await demoStorageService.getSections()).toEqual([]);
  });

  it('UNCLAIMED is allowed on an UNOWNED store — the pre-owner legacy case', async () => {
    // A store seeded before round 7 introduced the owner row: no owner exists, so
    // there is nobody to dispossess and the app must keep working.
    await demoStorageService.clearAllData();
    await emptyOwnerRow();
    resetDemoOwnershipToPageLoad();

    await expect(
      demoStorageService.createSection({ name: 'legacy', userId: 'A' }),
    ).resolves.toBeTruthy();
    expect((await demoStorageService.getSections()).map((s) => s.name)).toEqual(['legacy']);
  });
});

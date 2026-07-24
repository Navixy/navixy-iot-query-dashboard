/**
 * Demo Storage Service - Uses Dexie.js (IndexedDB wrapper) for local storage
 * This provides a local database for demo mode that persists across browser sessions
 */
import Dexie, { type Table } from 'dexie';
import type { RawReportSchema } from '@/types/dashboard-types';

/** Coerce an unknown backend date value (ISO string / epoch / Date) to a Date. */
const toDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date((value as string | number) ?? Date.now());

// ==========================================
// Type Definitions
// ==========================================

export interface DemoSection {
  id: string;
  name: string;
  sortOrder: number;
  version: number;
  isDeleted: boolean;
  userId: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DemoReport {
  id: string;
  title: string;
  sectionId: string | null;
  slug: string;
  sortOrder: number;
  version: number;
  reportSchema: RawReportSchema;
  isDeleted: boolean;
  userId: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DemoGlobalVariable {
  id: string;
  label: string;
  description: string | null;
  value: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DemoMetadata {
  id: string;
  key: string;
  value: unknown;
}

// ==========================================
// Dexie Database Definition
// ==========================================

class DemoDatabase extends Dexie {
  sections!: Table<DemoSection, string>;
  reports!: Table<DemoReport, string>;
  globalVariables!: Table<DemoGlobalVariable, string>;
  metadata!: Table<DemoMetadata, string>;
  chartCatalog!: Table<{ id: string; schemaVersion: string; groups: unknown[] }, string>;
  // Singleton owner token (review !62 round 7, finding 1): the ORIGIN-WIDE holder
  // of this per-origin singleton DB. Every tab shares this IndexedDB, so a sign-in
  // in another tab writes a new token here that THIS tab's destructive
  // transactions can see — which the tab-local React ref round 6 used could not.
  // Deliberately NOT cleared by clearAllData, so it survives across clears/seeds.
  owner!: Table<{ id: string; token: string }, string>;

  constructor() {
    super('NavixyDemoDatabase');

    this.version(1).stores({
      sections: 'id, name, sortOrder, userId, isDeleted',
      reports: 'id, title, sectionId, sortOrder, userId, isDeleted',
      globalVariables: 'id, label',
      metadata: 'id, key'
    });

    // v2: chart preset catalog — singleton row keyed by a fixed id (FR-11365)
    this.version(2).stores({
      sections: 'id, name, sortOrder, userId, isDeleted',
      reports: 'id, title, sectionId, sortOrder, userId, isDeleted',
      globalVariables: 'id, label',
      metadata: 'id, key',
      chartCatalog: 'id'
    });

    // v3: origin-wide demo-ownership token (review !62 round 7, finding 1). Adding
    // a store is a pure Dexie upgrade — the store starts empty; no data migrates.
    this.version(3).stores({
      sections: 'id, name, sortOrder, userId, isDeleted',
      reports: 'id, title, sectionId, sortOrder, userId, isDeleted',
      globalVariables: 'id, label',
      metadata: 'id, key',
      chartCatalog: 'id',
      owner: 'id'
    });
  }
}

const OWNER_KEY = 'current';

/** Mint an origin-wide ownership token. randomUUID needs a secure context
 *  (localhost + the https iframe host qualify); the fallback only needs
 *  uniqueness per claim on this origin. */
function mintOwnerToken(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Singleton instance
let db: DemoDatabase | null = null;

function getDb(): DemoDatabase {
  if (!db) {
    db = new DemoDatabase();
  }
  return db;
}

// ==========================================
// Demo Storage Service
// ==========================================

export class DemoStorageService {
  private static instance: DemoStorageService;

  private constructor() {}

  static getInstance(): DemoStorageService {
    if (!DemoStorageService.instance) {
      DemoStorageService.instance = new DemoStorageService();
    }
    return DemoStorageService.instance;
  }

  // ==========================================
  // Origin-wide demo ownership (review !62 round 7, finding 1)
  // ==========================================

  /**
   * Claim ownership of the singleton demo DB for a NEW sign-in and return the
   * minted token. Every destructive call made on behalf of this sign-in passes
   * the token back as `expectedOwner`; a later sign-in — in THIS tab or ANY other
   * tab on the origin — claims a new token, so those calls abort in-transaction
   * instead of clobbering the successor's data. Origin-wide because the token
   * lives in IndexedDB, not a per-tab React ref.
   */
  async claimDemoOwnership(): Promise<string> {
    const token = mintOwnerToken();
    await getDb().owner.put({ id: OWNER_KEY, token });
    return token;
  }

  /** The current origin-wide owner token, or undefined if none has been claimed.
   *  reseed/clear read this to pass themselves as the expected owner. */
  async readDemoOwner(): Promise<string | undefined> {
    return (await getDb().owner.get(OWNER_KEY))?.token;
  }

  // ==========================================
  // Initialization & Data Seeding
  // ==========================================

  /**
   * Seed the demo database with data from the backend.
   *
   * `expectedOwner` (review !62 round 7, finding 1) is the ORIGIN-WIDE ownership
   * token this caller holds; it is re-read from IndexedDB INSIDE each destructive
   * transaction — the internal clear and the bulk write — and the operation aborts
   * if ownership has moved to a newer sign-in in this or any other tab. IndexedDB
   * is a per-origin SINGLETON and serializes read/write transactions on
   * overlapping stores, so the in-transaction check cannot be overtaken. Omit
   * expectedOwner for an unconditional seed (legacy callers).
   *
   * Returns true if seeded, false if it ABORTED because ownership moved on — the
   * caller must propagate that so its continuation (a page reload) does not run.
   */
  async seedFromBackend(data: {
    sections: Record<string, unknown>[];
    reports: Record<string, unknown>[];
    globalVariables: Record<string, unknown>[];
    chartCatalog?: { schemaVersion?: string; groups?: unknown[] } | null;
    userId: string;
  }, expectedOwner?: string): Promise<boolean> {
    console.log('[DemoStorage] seedFromBackend called with:', {
      sectionsCount: data.sections?.length ?? 0,
      reportsCount: data.reports?.length ?? 0,
      globalVariablesCount: data.globalVariables?.length ?? 0,
      userId: data.userId
    });

    // Log raw input data for debugging
    if (data.reports?.length > 0) {
      console.log('[DemoStorage] Raw reports from backend:', data.reports.map(r => ({
        id: r.id,
        title: r.title,
        section_id: r.section_id,
        user_id: r.user_id,
        is_deleted: r.is_deleted,
        hasSchema: !!(r.report_schema || r.reportSchema)
      })));
    } else {
      console.warn('[DemoStorage] No reports received from backend!');
    }

    if (data.sections?.length > 0) {
      console.log('[DemoStorage] Raw sections from backend:', data.sections.map(s => ({
        id: s.id,
        name: s.name,
        user_id: s.user_id,
        is_deleted: s.is_deleted
      })));
    } else {
      console.warn('[DemoStorage] No sections received from backend!');
    }

    const database = getDb();

    // Clear existing data first (should already be cleared, but double-check).
    // Pass the ownership token through so this internal clear is guarded too; if it
    // aborts, ownership has moved on and we must not seed either.
    console.log('[DemoStorage] Clearing existing data before seeding...');
    if (!(await this.clearAllData(expectedOwner))) {
      console.log('[DemoStorage] Seed aborted: ownership moved on before the clear');
      return false;
    }

    // Seed sections
    const sections = data.sections.map(s => ({
      id: s.id,
      name: s.name,
      sortOrder: s.sort_order ?? s.sortOrder ?? 0,
      version: s.version ?? 1,
      isDeleted: s.is_deleted ?? s.isDeleted ?? false,
      userId: s.user_id ?? s.userId ?? data.userId,
      createdBy: s.created_by ?? s.createdBy ?? data.userId,
      updatedBy: s.updated_by ?? s.updatedBy ?? data.userId,
      createdAt: toDate(s.created_at ?? s.createdAt),
      updatedAt: toDate(s.updated_at ?? s.updatedAt)
    })) as DemoSection[];

    console.log('[DemoStorage] Transformed sections for IndexedDB:', sections.map(s => ({
      id: s.id,
      name: s.name,
      userId: s.userId,
      isDeleted: s.isDeleted
    })));

    // Seed reports
    const reports = data.reports.map(r => ({
      id: r.id,
      title: r.title,
      sectionId: r.section_id ?? r.sectionId ?? null,
      slug: r.slug ?? String(r.title).toLowerCase().replace(/\s+/g, '-'),
      sortOrder: r.sort_order ?? r.sortOrder ?? 0,
      version: r.version ?? 1,
      reportSchema: r.report_schema ?? r.reportSchema ?? {},
      isDeleted: r.is_deleted ?? r.isDeleted ?? false,
      userId: r.user_id ?? r.userId ?? data.userId,
      createdBy: r.created_by ?? r.createdBy ?? data.userId,
      updatedBy: r.updated_by ?? r.updatedBy ?? data.userId,
      createdAt: toDate(r.created_at ?? r.createdAt),
      updatedAt: toDate(r.updated_at ?? r.updatedAt)
    })) as DemoReport[];

    console.log('[DemoStorage] Transformed reports for IndexedDB:', reports.map(r => ({
      id: r.id,
      title: r.title,
      sectionId: r.sectionId,
      userId: r.userId,
      isDeleted: r.isDeleted,
      hasSchema: !!r.reportSchema && Object.keys(r.reportSchema).length > 0
    })));

    // Seed global variables
    const globalVariables = data.globalVariables.map(gv => ({
      id: gv.id,
      label: gv.label,
      description: gv.description ?? null,
      value: gv.value ?? null,
      createdAt: toDate(gv.created_at ?? gv.createdAt),
      updatedAt: toDate(gv.updated_at ?? gv.updatedAt)
    })) as DemoGlobalVariable[];

    console.log('[DemoStorage] Transformed global variables for IndexedDB:', globalVariables.map(gv => ({
      id: gv.id,
      label: gv.label
    })));

    // Store seeded data timestamp
    const metadata: DemoMetadata = {
      id: 'seed-info',
      key: 'seed-info',
      value: {
        seededAt: new Date().toISOString(),
        userId: data.userId,
        sectionCount: sections.length,
        reportCount: reports.length,
        globalVariableCount: globalVariables.length
      }
    };

    // Bulk insert all data
    console.log('[DemoStorage] Starting bulk insert to IndexedDB...');
    let aborted = false;
    try {
      await database.transaction('rw', [database.owner, database.sections, database.reports, database.globalVariables, database.metadata, database.chartCatalog], async () => {
        // Ownership guard INSIDE the write transaction (review !62 round 7, finding
        // 1): if a newer sign-in (any tab) claimed ownership while this run
        // fetched, do not overwrite the successor's freshly-seeded store.
        if (expectedOwner !== undefined) {
          const current = await database.owner.get(OWNER_KEY);
          if (current?.token !== expectedOwner) {
            aborted = true;
            return;
          }
        }
        if (sections.length > 0) {
          console.log('[DemoStorage] Inserting', sections.length, 'sections...');
          await database.sections.bulkAdd(sections);
        }
        if (reports.length > 0) {
          console.log('[DemoStorage] Inserting', reports.length, 'reports...');
          await database.reports.bulkAdd(reports);
        }
        if (globalVariables.length > 0) {
          console.log('[DemoStorage] Inserting', globalVariables.length, 'global variables...');
          await database.globalVariables.bulkAdd(globalVariables);
        }
        await database.metadata.put(metadata);
        // Always write the catalog row (even when empty). clearAllData() unconditionally wipes
        // chartCatalog, so a conditional insert would leave the dock stale after a re-seed where
        // the backend fetch failed (the only case data.chartCatalog is null).
        const catalog = data.chartCatalog ?? { schemaVersion: '1.0', groups: [] };
        console.log('[DemoStorage] Inserting chart preset catalog...');
        await database.chartCatalog.put({
          id: 'catalog',
          schemaVersion: catalog.schemaVersion || '1.0',
          groups: Array.isArray(catalog.groups) ? catalog.groups : []
        });
      });
      console.log('[DemoStorage] Bulk insert completed successfully');
    } catch (error) {
      console.error('[DemoStorage] Bulk insert failed:', error);
      throw error;
    }

    // The write was skipped because a newer identity took over — leave its data
    // untouched and do not run the mismatch verification against it.
    if (aborted) {
      console.log('[DemoStorage] Seed superseded before write; left current identity data intact');
      return false;
    }

    // Verify data was inserted correctly
    const insertedReports = await database.reports.count();
    const insertedSections = await database.sections.count();
    const insertedGlobalVars = await database.globalVariables.count();
    
    console.log('[DemoStorage] Database seeded successfully - Verification:', {
      sectionsInserted: insertedSections,
      reportsInserted: insertedReports,
      globalVariablesInserted: insertedGlobalVars,
      expectedSections: sections.length,
      expectedReports: reports.length,
      expectedGlobalVars: globalVariables.length
    });

    if (insertedReports !== reports.length) {
      console.error('[DemoStorage] MISMATCH: Expected', reports.length, 'reports but found', insertedReports, 'in IndexedDB');
    }
    return true;
  }

  /**
   * Check if demo database has been seeded
   */
  async isSeeded(): Promise<boolean> {
    const database = getDb();
    const seedInfo = await database.metadata.get('seed-info');
    return !!seedInfo;
  }

  /**
   * Clear all demo data.
   *
   * `expectedOwner` (review !62 round 7, finding 1) is the ORIGIN-WIDE ownership
   * token this caller holds. It is re-read from IndexedDB as the FIRST statement
   * inside the destructive transaction and compared there — not via a tab-local
   * ref — so a sign-in in ANOTHER tab that claimed a new token aborts this clear
   * instead of wiping the successor's data. IndexedDB serializes overlapping-store
   * transactions, so the in-transaction check cannot be overtaken. Omit
   * expectedOwner for an unconditional clear (legacy callers).
   *
   * Returns true if the data was cleared, false if the transaction ABORTED because
   * ownership had moved on — the caller must propagate that so its continuation
   * (a sign-out, a page reload) does not run on the successor's behalf.
   */
  async clearAllData(expectedOwner?: string): Promise<boolean> {
    const database = getDb();

    // Log what we're about to delete
    const existingReports = await database.reports.count();
    const existingSections = await database.sections.count();
    const existingGlobalVars = await database.globalVariables.count();

    console.log('[DemoStorage] Clearing all data. Current counts:', {
      reports: existingReports,
      sections: existingSections,
      globalVariables: existingGlobalVars
    });

    let aborted = false;
    await database.transaction('rw', [database.owner, database.sections, database.reports, database.globalVariables, database.metadata, database.chartCatalog], async () => {
      if (expectedOwner !== undefined) {
        const current = await database.owner.get(OWNER_KEY);
        if (current?.token !== expectedOwner) {
          console.log('[DemoStorage] Clear superseded: ownership moved to another sign-in; aborting');
          aborted = true;
          return;
        }
      }
      await database.sections.clear();
      await database.reports.clear();
      await database.globalVariables.clear();
      await database.metadata.clear();
      await database.chartCatalog.clear();
      // owner is intentionally NOT cleared — it identifies the current holder.
    });
    if (aborted) return false;

    // Verify everything is cleared
    const afterReports = await database.reports.count();
    const afterSections = await database.sections.count();
    console.log('[DemoStorage] All data cleared. Verification:', {
      reportsAfterClear: afterReports,
      sectionsAfterClear: afterSections
    });
    return true;
  }

  // ==========================================
  // Chart Library preset catalog (FR-11365)
  // ==========================================

  async getChartCatalog(): Promise<{ schemaVersion: string; groups: unknown[] } | null> {
    const database = getDb();
    const row = await database.chartCatalog.get('catalog');
    if (!row) return null;
    return { schemaVersion: row.schemaVersion, groups: Array.isArray(row.groups) ? row.groups : [] };
  }

  // ==========================================
  // Sections CRUD
  // ==========================================

  async getSections(userId?: string): Promise<DemoSection[]> {
    const database = getDb();
    const query = database.sections.where('isDeleted').equals(0); // IndexedDB stores booleans as 0/1
    
    // Dexie doesn't support compound where on different fields well, so filter in memory
    let sections = await database.sections.toArray();
    sections = sections.filter(s => !s.isDeleted);
    
    if (userId) {
      sections = sections.filter(s => s.userId === userId);
    }
    
    return sections.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async createSection(data: {
    name: string;
    sortOrder?: number;
    userId: string;
  }): Promise<DemoSection> {
    const database = getDb();
    
    const section: DemoSection = {
      id: crypto.randomUUID(),
      name: data.name,
      sortOrder: data.sortOrder ?? 0,
      version: 1,
      isDeleted: false,
      userId: data.userId,
      createdBy: data.userId,
      updatedBy: data.userId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await database.sections.add(section);
    return section;
  }

  async updateSection(id: string, data: {
    name?: string;
    sortOrder?: number;
    userId: string;
    version: number;
  }): Promise<DemoSection> {
    const database = getDb();
    
    const existing = await database.sections.get(id);
    if (!existing) {
      throw new Error('Section not found');
    }
    
    if (existing.version !== data.version) {
      throw new Error('Version conflict');
    }

    const updated: Partial<DemoSection> = {
      updatedAt: new Date(),
      updatedBy: data.userId,
      version: existing.version + 1
    };

    if (data.name !== undefined) updated.name = data.name;
    if (data.sortOrder !== undefined) updated.sortOrder = data.sortOrder;

    await database.sections.update(id, updated);
    
    return { ...existing, ...updated } as DemoSection;
  }

  async deleteSection(id: string, strategy: 'move_children_to_root' | 'delete_children', userId: string): Promise<{ affectedReports: number }> {
    const database = getDb();
    
    const section = await database.sections.get(id);
    if (!section || section.isDeleted) {
      throw new Error('Section not found');
    }

    // Get child reports
    const childReports = await database.reports
      .filter(r => r.sectionId === id && !r.isDeleted)
      .toArray();

    const affectedReports = childReports.length;

    await database.transaction('rw', [database.sections, database.reports], async () => {
      if (strategy === 'move_children_to_root') {
        // Move reports to root
        for (const report of childReports) {
          await database.reports.update(report.id, {
            sectionId: null,
            updatedAt: new Date(),
            updatedBy: userId
          });
        }
      } else {
        // Delete children
        for (const report of childReports) {
          await database.reports.update(report.id, {
            isDeleted: true,
            updatedAt: new Date(),
            updatedBy: userId
          });
        }
      }

      // Soft delete section
      await database.sections.update(id, {
        isDeleted: true,
        updatedAt: new Date(),
        updatedBy: userId
      });
    });

    return { affectedReports };
  }

  async restoreSection(id: string, userId: string): Promise<void> {
    const database = getDb();
    
    const section = await database.sections.get(id);
    if (!section || !section.isDeleted) {
      throw new Error('Deleted section not found');
    }

    await database.sections.update(id, {
      isDeleted: false,
      updatedAt: new Date(),
      updatedBy: userId
    });
  }

  // ==========================================
  // Reports CRUD
  // ==========================================

  async getReports(userId?: string): Promise<DemoReport[]> {
    const database = getDb();
    
    let reports = await database.reports.toArray();
    console.log('[DemoStorage] getReports - Total reports in IndexedDB:', reports.length);
    
    const beforeFilter = reports.length;
    reports = reports.filter(r => !r.isDeleted);
    console.log('[DemoStorage] getReports - After filtering isDeleted:', {
      before: beforeFilter,
      after: reports.length,
      filteredOut: beforeFilter - reports.length
    });
    
    if (userId) {
      const beforeUserFilter = reports.length;
      reports = reports.filter(r => r.userId === userId);
      console.log('[DemoStorage] getReports - After filtering by userId:', {
        userId,
        before: beforeUserFilter,
        after: reports.length,
        filteredOut: beforeUserFilter - reports.length
      });
    }
    
    console.log('[DemoStorage] getReports - Returning reports:', reports.map(r => ({
      id: r.id,
      title: r.title,
      userId: r.userId,
      isDeleted: r.isDeleted
    })));
    
    return reports.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async getReportById(id: string, userId?: string): Promise<DemoReport | null> {
    const database = getDb();
    
    const report = await database.reports.get(id);
    if (!report || report.isDeleted) return null;
    if (userId && report.userId !== userId) return null;
    
    return report;
  }

  async createReport(data: {
    title: string;
    sectionId?: string | null;
    slug?: string;
    sortOrder?: number;
    reportSchema: unknown;
    userId: string;
  }): Promise<DemoReport> {
    const database = getDb();
    
    const report: DemoReport = {
      id: crypto.randomUUID(),
      title: data.title,
      sectionId: data.sectionId ?? null,
      slug: data.slug ?? data.title.toLowerCase().replace(/\s+/g, '-'),
      sortOrder: data.sortOrder ?? 0,
      version: 1,
      reportSchema: data.reportSchema as RawReportSchema,
      isDeleted: false,
      userId: data.userId,
      createdBy: data.userId,
      updatedBy: data.userId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await database.reports.add(report);
    return report;
  }

  async updateReport(id: string, data: {
    title?: string;
    subtitle?: string;
    sectionId?: string | null;
    sortOrder?: number;
    reportSchema?: unknown;
    userId: string;
    version?: number;
  }): Promise<DemoReport> {
    const database = getDb();
    
    const existing = await database.reports.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error('Report not found');
    }

    // Check version if provided
    if (data.version !== undefined && existing.version !== data.version) {
      throw new Error('Version conflict');
    }

    const updated: Partial<DemoReport> = {
      updatedAt: new Date(),
      updatedBy: data.userId,
      version: existing.version + 1
    };

    if (data.title !== undefined) updated.title = data.title;
    if (data.sectionId !== undefined) updated.sectionId = data.sectionId;
    if (data.sortOrder !== undefined) updated.sortOrder = data.sortOrder;
    if (data.reportSchema !== undefined) updated.reportSchema = data.reportSchema as RawReportSchema;

    await database.reports.update(id, updated);
    
    return { ...existing, ...updated } as DemoReport;
  }

  async deleteReport(id: string, userId: string): Promise<void> {
    const database = getDb();
    
    const report = await database.reports.get(id);
    if (!report || report.isDeleted) {
      throw new Error('Report not found');
    }

    await database.reports.update(id, {
      isDeleted: true,
      updatedAt: new Date(),
      updatedBy: userId
    });
  }

  async restoreReport(id: string, userId: string): Promise<void> {
    const database = getDb();
    
    const report = await database.reports.get(id);
    if (!report || !report.isDeleted) {
      throw new Error('Deleted report not found');
    }

    await database.reports.update(id, {
      isDeleted: false,
      updatedAt: new Date(),
      updatedBy: userId
    });
  }

  // ==========================================
  // Menu Tree (combines sections and reports)
  // ==========================================

  async getMenuTree(userId: string, includeDeleted: boolean = false): Promise<{
    sections: Array<{ id: string; name: string; sortOrder: number; version: number }>;
    rootReports: Array<{ id: string; name: string; sortOrder: number; version: number; parentSectionId: null }>;
    sectionReports: Record<string, Array<{ id: string; name: string; sortOrder: number; version: number; parentSectionId: string }>>;
  }> {
    const database = getDb();
    
    let sections = await database.sections.toArray();
    let reports = await database.reports.toArray();

    // Filter by user and deleted status
    sections = sections.filter(s => 
      s.userId === userId && (includeDeleted || !s.isDeleted)
    );
    reports = reports.filter(r => 
      r.userId === userId && (includeDeleted || !r.isDeleted)
    );

    // Sort
    sections.sort((a, b) => a.sortOrder - b.sortOrder);
    reports.sort((a, b) => a.sortOrder - b.sortOrder);

    // Build tree structure
    const rootReports = reports
      .filter(r => !r.sectionId)
      .map(r => ({
        id: r.id,
        name: r.title,
        sortOrder: r.sortOrder,
        version: r.version,
        type: r.reportSchema?.type === 'composite' ? 'composite' : 'standard',
        parentSectionId: null as null
      }));

    const sectionReports: Record<string, Array<{ id: string; name: string; sortOrder: number; version: number; parentSectionId: string }>> = {};
    
    for (const section of sections) {
      sectionReports[section.id] = reports
        .filter(r => r.sectionId === section.id)
        .map(r => ({
          id: r.id,
          name: r.title,
          sortOrder: r.sortOrder,
          version: r.version,
          type: r.reportSchema?.type === 'composite' ? 'composite' : 'standard',
          parentSectionId: section.id
        }));
    }

    return {
      sections: sections.map(s => ({
        id: s.id,
        name: s.name,
        sortOrder: s.sortOrder,
        version: s.version
      })),
      rootReports,
      sectionReports
    };
  }

  async reorderMenu(payload: {
    sections: Array<{ id: string; sortOrder: number; version: number }>;
    reports: Array<{ id: string; parentSectionId: string | null; sortOrder: number; version: number }>;
    userId: string;
  }): Promise<{ newVersions: Record<string, number> }> {
    const database = getDb();
    const newVersions: Record<string, number> = {};

    await database.transaction('rw', [database.sections, database.reports], async () => {
      // Update sections
      for (const section of payload.sections) {
        const existing = await database.sections.get(section.id);
        if (!existing) throw new Error(`Section ${section.id} not found`);
        if (existing.version !== section.version) throw new Error(`Version conflict for section ${section.id}`);

        const newVersion = existing.version + 1;
        await database.sections.update(section.id, {
          sortOrder: section.sortOrder,
          version: newVersion,
          updatedAt: new Date(),
          updatedBy: payload.userId
        });
        newVersions[section.id] = newVersion;
      }

      // Update reports
      for (const report of payload.reports) {
        const existing = await database.reports.get(report.id);
        if (!existing) throw new Error(`Report ${report.id} not found`);
        if (existing.version !== report.version) throw new Error(`Version conflict for report ${report.id}`);

        const newVersion = existing.version + 1;
        await database.reports.update(report.id, {
          sectionId: report.parentSectionId,
          sortOrder: report.sortOrder,
          version: newVersion,
          updatedAt: new Date(),
          updatedBy: payload.userId
        });
        newVersions[report.id] = newVersion;
      }
    });

    return { newVersions };
  }

  // ==========================================
  // Global Variables CRUD
  // ==========================================

  async getGlobalVariables(): Promise<DemoGlobalVariable[]> {
    const database = getDb();
    const variables = await database.globalVariables.toArray();
    return variables.sort((a, b) => a.label.localeCompare(b.label));
  }

  async getGlobalVariableById(id: string): Promise<DemoGlobalVariable | null> {
    const database = getDb();
    return await database.globalVariables.get(id) ?? null;
  }

  async createGlobalVariable(data: {
    label: string;
    description?: string;
    value?: string;
  }): Promise<DemoGlobalVariable> {
    const database = getDb();
    
    // Check for duplicate label
    const existing = await database.globalVariables.where('label').equals(data.label).first();
    if (existing) {
      throw new Error('A variable with this label already exists');
    }

    const variable: DemoGlobalVariable = {
      id: crypto.randomUUID(),
      label: data.label,
      description: data.description ?? null,
      value: data.value ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await database.globalVariables.add(variable);
    return variable;
  }

  async updateGlobalVariable(id: string, data: {
    label?: string;
    description?: string;
    value?: string;
  }): Promise<DemoGlobalVariable> {
    const database = getDb();
    
    const existing = await database.globalVariables.get(id);
    if (!existing) {
      throw new Error('Global variable not found');
    }

    // Check for duplicate label if changing label
    if (data.label && data.label !== existing.label) {
      const duplicate = await database.globalVariables.where('label').equals(data.label).first();
      if (duplicate) {
        throw new Error('A variable with this label already exists');
      }
    }

    const updated: Partial<DemoGlobalVariable> = {
      updatedAt: new Date()
    };

    if (data.label !== undefined) updated.label = data.label;
    if (data.description !== undefined) updated.description = data.description;
    if (data.value !== undefined) updated.value = data.value;

    await database.globalVariables.update(id, updated);
    
    return { ...existing, ...updated } as DemoGlobalVariable;
  }

  async deleteGlobalVariable(id: string): Promise<void> {
    const database = getDb();
    
    const existing = await database.globalVariables.get(id);
    if (!existing) {
      throw new Error('Global variable not found');
    }

    await database.globalVariables.delete(id);
  }
}

// Export singleton instance
export const demoStorageService = DemoStorageService.getInstance();

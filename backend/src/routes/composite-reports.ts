import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import fastq from 'fastq';
import type { queueAsPromised } from 'fastq';
import { DatabaseService } from '../services/database.js';
import { ExportService } from '../services/export.js';
import { resolveExportPreferences } from '../services/userPreferences.js';
import { authenticateToken, requireAdminOrEditor } from '../middleware/auth.js';
import { rejectDemoWrites } from '../middleware/demoGuard.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { CustomError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { getTimeoutFromGlobalVars, resolveExportTimeoutMs, clampRowsToHardCap } from '../utils/exportPolicy.js';
import { detectAllGPSColumnPairs, detectValidGPSColumns, selectValidGPSPair, toRowObjects, extractGPSPoints, suggestLabelColumn, isDisplayableCoordinate, type ColumnInfo } from '../utils/gpsDetection.js';
import { applyGeocodedAddresses } from '../utils/geocodeColumns.js';
import { sanitizeTimeZone } from '../utils/datetime.js';
import { toErrorMeta } from '../utils/errors.js';

const router = Router();

/**
 * Shape of a composite report row as consumed by these handlers. The DB layer
 * returns loosely-typed rows (`Record<string, unknown>`); we narrow to this
 * structure at the read sites. The index signature keeps it assignable from the
 * generic row type.
 *
 * Source of truth for the columns is the SELECT in
 * `DatabaseService.getCompositeReports` / `getCompositeReportById`
 * (`backend/src/services/database.ts`) — keep this interface in sync with those.
 */
interface CompositeReportRecord {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  sql_query: string;
  config: {
    table?: { enabled: boolean; pageSize?: number; maxRows?: number; showTotals?: boolean };
    chart?: { enabled: boolean; type?: string; xColumn?: string; yColumns?: string[] };
    map?: { enabled: boolean; autoDetect?: boolean; latColumn?: string; lonColumn?: string; labelColumn?: string };
  };
  report_schema?: Record<string, unknown>;
  [key: string]: unknown;
}

function safeContentDisposition(slug: string, ext: string): string {
  const ts = Date.now();
  const asciiName = slug.replace(/[^\x20-\x7E]/g, '').replace(/["/\\]/g, '') || 'composite-report';
  const utf8Name = encodeURIComponent(`${slug}-${ts}.${ext}`);
  return `attachment; filename="${asciiName}-${ts}.${ext}"; filename*=UTF-8''${utf8Name}`;
}

// Helper to extract user info from request
function getUserInfo(req: Request): { userDbUrl: string; userId: string; iotDbUrl?: string; sessionId?: string } {
  const user = (req as AuthenticatedRequest).user;
  const userDbUrl = user?.userDbUrl;
  const userId = user?.userId;
  const iotDbUrl = user?.iotDbUrl;
  const sessionId = user?.session_id;

  if (!userDbUrl || typeof userDbUrl !== 'string') {
    throw new CustomError('User database URL not configured', 400);
  }

  if (!userId || typeof userId !== 'string') {
    throw new CustomError('User ID not found', 400);
  }

  return {
    userDbUrl,
    userId,
    ...(iotDbUrl !== undefined ? { iotDbUrl } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/composite-reports
 * List all composite reports for the authenticated user
 */
router.get('/composite-reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userDbUrl, userId } = getUserInfo(req);

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    const compositeReports = await dbService.getCompositeReports(pool, userId);

    res.json({
      success: true,
      data: compositeReports,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/composite-reports/:id
 * Get a single composite report by ID
 */
router.get('/composite-reports/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { userDbUrl, userId } = getUserInfo(req);

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    const compositeReport = await dbService.getCompositeReportById(id, pool, userId) as CompositeReportRecord | null;

    if (!compositeReport) {
      throw new CustomError('Composite report not found', 404);
    }

    res.json({
      success: true,
      data: compositeReport,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/composite-reports
 * Create a new composite report
 */
router.post('/composite-reports', rejectDemoWrites, requireAdminOrEditor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, description, slug, section_id, sort_order, sql_query, config, report_schema } = req.body;
    const { userDbUrl, userId } = getUserInfo(req);

    // Validation
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new CustomError('Title is required', 400);
    }

    if (!sql_query || typeof sql_query !== 'string' || sql_query.trim().length === 0) {
      throw new CustomError('SQL query is required', 400);
    }

    // Generate slug if not provided
    const finalSlug = slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Default config if not provided
    const defaultConfig = {
      table: { enabled: true, pageSize: 50, maxRows: 10000, showTotals: false },
      chart: { enabled: true, type: 'timeseries', xColumn: '', yColumns: [] },
      map: { enabled: false, autoDetect: true },
    };

    const finalConfig = config ? { ...defaultConfig, ...config } : defaultConfig;

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);

    const compositeReport = await dbService.createCompositeReport({
      title: title.trim(),
      description: description?.trim() || null,
      slug: finalSlug,
      section_id: section_id || null,
      sort_order: sort_order || 0,
      sql_query: sql_query.trim(),
      config: finalConfig,
      report_schema: report_schema || null,
      user_id: userId,
      created_by: userId,
    }, pool);

    logger.info('Created composite report', { id: compositeReport.id, title, userId });

    res.status(201).json({
      success: true,
      data: compositeReport,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/composite-reports/:id
 * Update an existing composite report
 */
router.put('/composite-reports/:id', rejectDemoWrites, requireAdminOrEditor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { title, description, slug, section_id, sort_order, sql_query, config, report_schema } = req.body;
    const { userDbUrl, userId } = getUserInfo(req);

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    
    const compositeReport = await dbService.updateCompositeReport(id, {
      title: title?.trim(),
      description: description?.trim(),
      slug,
      section_id,
      sort_order,
      sql_query: sql_query?.trim(),
      config,
      report_schema,
      updated_by: userId,
    }, pool, userId);

    logger.info('Updated composite report', { id, userId });

    res.json({
      success: true,
      data: compositeReport,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/composite-reports/:id
 * Soft delete a composite report
 */
router.delete('/composite-reports/:id', rejectDemoWrites, requireAdminOrEditor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { userDbUrl, userId } = getUserInfo(req);

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    
    await dbService.deleteCompositeReport(id, pool, userId);

    logger.info('Deleted composite report', { id, userId });

    res.json({
      success: true,
      message: 'Composite report deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/composite-reports/:id/execute
 * Execute the SQL query for a composite report and return data
 */
router.post('/composite-reports/:id/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { params = {}, time_zone } = req.body;
    const { userDbUrl, userId, iotDbUrl } = getUserInfo(req);

    // Viewer's zone for SQL-side time rendering; invalid names degrade to the
    // server default (DO-352).
    const timeZone = sanitizeTimeZone(time_zone);

    if (!iotDbUrl) {
      throw new CustomError('IoT database URL not configured', 400);
    }

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);

    // Get the composite report
    const compositeReport = await dbService.getCompositeReportById(id, pool, userId) as CompositeReportRecord | null;
    if (!compositeReport) {
      throw new CustomError('Composite report not found', 404);
    }

    const maxRows = compositeReport.config?.table?.maxRows || 10000;

    // Check if SQL query is valid
    const sqlQuery = compositeReport.sql_query?.trim();
    if (!sqlQuery) {
      // Return empty result for empty query
      res.json({
        success: true,
        data: {
          columns: [],
          rows: [],
          stats: { rowCount: 0, executionTime: 0 },
          gps: null,
          message: 'No SQL query configured for this report',
        },
      });
      return;
    }

    // Merge global variables with provided params (explicit params take precedence)
    const { mergedParams, globalVars } = await dbService.mergeWithGlobalVars(params, pool);

    // Get timeout from global variables (default 30s)
    const timeoutMs = getTimeoutFromGlobalVars(globalVars);

    // Execute the SQL query — no server-side pagination needed,
    // composite reports load all data at once and paginate client-side
    let result;
    try {
      result = await dbService.executeParameterizedQuery(
        sqlQuery,
        mergedParams,
        timeoutMs,
        maxRows,
        iotDbUrl,
        undefined,
        timeZone,
      );
    } catch (queryError) {
      // Return empty result with error message for SQL errors
      logger.warn('Composite report SQL execution failed:', toErrorMeta(queryError).message);
      res.json({
        success: true,
        data: {
          columns: [],
          rows: [],
          stats: { rowCount: 0, executionTime: 0 },
          gps: null,
          error: toErrorMeta(queryError).message,
          message: 'Query execution failed',
        },
      });
      return;
    }

    // Convert column info for GPS detection
    const columnInfo: ColumnInfo[] = result.columns.map(col => ({
      name: col.name,
      type: col.type,
    }));

    // Always detect all GPS column pairs for geocoding support
    const allGpsPairs = detectAllGPSColumnPairs(columnInfo);

    // Auto-detect GPS columns for map if enabled
    let gpsInfo = null;
    const mapConfig = compositeReport.config?.map;
    if (mapConfig?.enabled) {
      if (mapConfig.autoDetect) {
        if (allGpsPairs.length > 0) {
          const rowObjects = toRowObjects(columnInfo, result.rows);
          // Pick the first detected pair that actually carries valid coordinates
          // rather than blindly using allGpsPairs[0]: a query may expose several
          // name-matching pairs (e.g. an all-null start_lat/start_lon alongside a
          // populated lat/lon), and only a populated one should drive the map.
          // Reuse allGpsPairs (already computed above) instead of re-detecting.
          const detectedGPS = selectValidGPSPair(allGpsPairs, rowObjects);
          if (detectedGPS) {
            const labelColumn = suggestLabelColumn(columnInfo);
            gpsInfo = {
              ...detectedGPS,
              labelColumn,
              hasValidData: true,
              pointCount: extractGPSPoints(rowObjects, detectedGPS).length,
            };
          }
        }
      } else if (mapConfig.latColumn && mapConfig.lonColumn) {
        gpsInfo = {
          latColumn: mapConfig.latColumn,
          lonColumn: mapConfig.lonColumn,
          labelColumn: mapConfig.labelColumn,
          hasValidData: true,
        };
      }
    }

    res.json({
      success: true,
      data: {
        columns: result.columns,
        rows: result.rows,
        stats: result.stats,
        pagination: result.pagination,
        gps: gpsInfo,
        gpsPairs: allGpsPairs.length > 0 ? allGpsPairs : undefined,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/composite-reports/:id/detect-columns
 * Detect columns from the SQL query (for configuration UI)
 */
router.post('/composite-reports/:id/detect-columns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { userDbUrl, userId, iotDbUrl } = getUserInfo(req);

    if (!iotDbUrl) {
      throw new CustomError('IoT database URL not configured', 400);
    }

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    
    // Get the composite report
    const compositeReport = await dbService.getCompositeReportById(id, pool, userId) as CompositeReportRecord | null;
    if (!compositeReport) {
      throw new CustomError('Composite report not found', 404);
    }

    // Execute query with limit 1 to get column info
    const result = await dbService.executeParameterizedQuery(
      compositeReport.sql_query,
      {},
      10000,
      1,
      iotDbUrl
    );

    const columnInfo: ColumnInfo[] = result.columns.map(col => ({
      name: col.name,
      type: col.type,
    }));

    // Detect all GPS column pairs
    const allGpsPairs = detectAllGPSColumnPairs(columnInfo);
    const gpsColumns = allGpsPairs.length > 0 ? allGpsPairs[0] : null;
    const labelColumn = suggestLabelColumn(columnInfo);

    // Suggest chart columns (numeric columns for Y, timestamp/date for X)
    const numericColumns = columnInfo.filter(col => 
      ['real', 'double precision', 'numeric', 'integer', 'bigint', 'smallint'].some(t => col.type.includes(t))
    );
    const timeColumns = columnInfo.filter(col =>
      ['timestamp', 'date', 'time'].some(t => col.type.includes(t))
    );

    res.json({
      success: true,
      data: {
        columns: columnInfo,
        suggestions: {
          gps: gpsColumns,
          gpsPairs: allGpsPairs.length > 0 ? allGpsPairs : undefined,
          labelColumn,
          xColumn: timeColumns[0]?.name || columnInfo[0]?.name,
          yColumns: numericColumns.slice(0, 3).map(c => c.name),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/composite-reports/:id/export/excel
 * Export composite report data as Excel (xlsx) or CSV file
 */
router.post('/composite-reports/:id/export/excel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { params = {}, geocodedAddresses, latColumn, lonColumn, gpsPairs, format = 'xlsx', report_data, cachedData, excelHeader } = req.body;
    const { userDbUrl, userId, iotDbUrl } = getUserInfo(req);

    if (!iotDbUrl) {
      throw new CustomError('IoT database URL not configured', 400);
    }

    // Validate format
    if (format !== 'xlsx' && format !== 'csv') {
      throw new CustomError('Invalid format. Must be "xlsx" or "csv"', 400);
    }

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    
    // Get the composite report from DB, or use report_data from request body (demo mode)
    let compositeReport = await dbService.getCompositeReportById(id, pool, userId) as CompositeReportRecord | null;
    if (!compositeReport && report_data?.sql_query) {
      compositeReport = {
        id,
        title: report_data.title || 'Report',
        description: report_data.description || '',
        slug: report_data.slug || 'report',
        sql_query: report_data.sql_query,
        config: report_data.config || {},
        section_id: null,
        sort_order: 0,
        version: 1,
        user_id: userId,
        is_deleted: false,
        created_at: new Date(),
        updated_at: new Date(),
      };
    }
    if (!compositeReport) {
      throw new CustomError('Composite report not found', 404);
    }

    // Resolved before the optional re-query so the export SQL runs in the same
    // zone the live view ran in (DO-352).
    const exportPrefs = await resolveExportPreferences(req as AuthenticatedRequest, req.body);

    // Use cached data from the frontend when available (prevents data drift with relative time queries)
    let queryResult: { columns: { name: string; type: string }[]; rows: unknown[][] };
    if (cachedData?.columns && cachedData?.rows) {
      queryResult = { columns: cachedData.columns, rows: cachedData.rows };
    } else {
      const { mergedParams, globalVars } = await dbService.mergeWithGlobalVars(params, pool);
      const exportTimeoutMs = resolveExportTimeoutMs(globalVars);
      const exportMaxRows = compositeReport.config?.table?.maxRows || 10000;
      const result = await dbService.executeParameterizedQuery(
        compositeReport.sql_query,
        mergedParams,
        exportTimeoutMs,
        exportMaxRows,
        iotDbUrl,
        undefined,
        exportPrefs.timeZone
      );
      queryResult = { columns: result.columns, rows: result.rows };
    }

    // Apply geocoded addresses if provided
    const { columns, rows } = applyGeocodedAddresses(
      queryResult.columns,
      queryResult.rows,
      geocodedAddresses,
      latColumn,
      lonColumn,
      gpsPairs
    );

    // Bound the rows fed to the (streaming) exporter. The re-query path is
    // capped by config.maxRows, but a client-supplied `cachedData` array — or a
    // very high config.maxRows — is otherwise unbounded; the panel export path
    // clamps the same way. Truncate + log rather than stream an unbounded
    // multi-hundred-MB workbook.
    const { rows: exportRows, truncated: rowsTruncated, originalCount, cap } = clampRowsToHardCap(rows);
    if (rowsTruncated) {
      logger.warn('Composite export exceeded row hard cap; truncating', {
        id,
        rowCount: originalCount,
        cap,
      });
    }

    const exportService = ExportService.getInstance();
    const exportOptions = {
      title: compositeReport.title,
      description: compositeReport.description,
      columns,
      rows: exportRows,
      executedAt: new Date(),
      ...(excelHeader && { excelHeader }),
      ...(exportPrefs.timeZone && { timeZone: exportPrefs.timeZone }),
      ...(exportPrefs.dateFormat && { dateFormat: exportPrefs.dateFormat }),
      ...(exportPrefs.timeFormat && { timeFormat: exportPrefs.timeFormat }),
    };

    if (format === 'csv') {
      // Generate CSV file
      const csvBuffer = exportService.generateCSV(exportOptions);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', safeContentDisposition(compositeReport.slug || 'composite-report', 'csv'));
      res.setHeader('Content-Length', csvBuffer.length);

      res.send(csvBuffer);
    } else {
      // Generate Excel file (default), streamed in chunks (no Content-Length)
      // to keep memory flat on large exports. See ExportService.streamExcel.
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', safeContentDisposition(compositeReport.slug || 'composite-report', 'xlsx'));

      await exportService.streamExcel(exportOptions, res);
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/composite-reports/:id/export/html
 * Export composite report as self-contained HTML
 */
router.post('/composite-reports/:id/export/html', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { params = {}, includeChart = true, includeMap = true, geocodedAddresses, latColumn, lonColumn, gpsPairs, chartSettings, mapSettings, report_data, cachedData } = req.body;
    const { userDbUrl, userId, iotDbUrl } = getUserInfo(req);

    if (!iotDbUrl) {
      throw new CustomError('IoT database URL not configured', 400);
    }

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    
    // Get the composite report from DB, or use report_data from request body (demo mode)
    let compositeReport = await dbService.getCompositeReportById(id, pool, userId) as CompositeReportRecord | null;
    if (!compositeReport && report_data?.sql_query) {
      compositeReport = {
        id,
        title: report_data.title || 'Report',
        description: report_data.description || '',
        slug: report_data.slug || 'report',
        sql_query: report_data.sql_query,
        config: report_data.config || {},
        section_id: null,
        sort_order: 0,
        version: 1,
        user_id: userId,
        is_deleted: false,
        created_at: new Date(),
        updated_at: new Date(),
      };
    }
    if (!compositeReport) {
      throw new CustomError('Composite report not found', 404);
    }

    // Resolved before the optional re-query so the export SQL runs in the same
    // zone the live view ran in (DO-352).
    const exportPrefs = await resolveExportPreferences(req as AuthenticatedRequest, req.body);

    // Use cached data from the frontend when available
    let queryResult: { columns: { name: string; type: string }[]; rows: unknown[][] };
    if (cachedData?.columns && cachedData?.rows) {
      queryResult = { columns: cachedData.columns, rows: cachedData.rows };
    } else {
      const { mergedParams, globalVars } = await dbService.mergeWithGlobalVars(params, pool);
      const exportTimeoutMs = resolveExportTimeoutMs(globalVars);
      const htmlExportMaxRows = compositeReport.config?.table?.maxRows || 10000;
      const result = await dbService.executeParameterizedQuery(
        compositeReport.sql_query,
        mergedParams,
        exportTimeoutMs,
        htmlExportMaxRows,
        iotDbUrl,
        undefined,
        exportPrefs.timeZone
      );
      queryResult = { columns: result.columns, rows: result.rows };
    }

    // Apply geocoded addresses if provided
    const { columns, rows } = applyGeocodedAddresses(
      queryResult.columns,
      queryResult.rows,
      geocodedAddresses,
      latColumn,
      lonColumn,
      gpsPairs
    );

    // Detect GPS columns for map (use original columns, not geocoded ones for map functionality)
    const columnInfo: ColumnInfo[] = queryResult.columns.map(col => ({
      name: col.name,
      type: col.type,
    }));
    // Only detect GPS columns when a map will actually render — otherwise skip
    // the full-row toRowObjects/validation scan (the default config has the map
    // disabled, so a plain data export shouldn't pay for it).
    const mapWanted = includeMap && compositeReport.config?.map?.enabled;
    const gpsColumns = !mapWanted
      ? null
      : compositeReport.config?.map?.autoDetect
        ? detectValidGPSColumns(columnInfo, toRowObjects(columnInfo, queryResult.rows))
        : compositeReport.config?.map?.latColumn && compositeReport.config?.map?.lonColumn
          ? { latColumn: compositeReport.config.map.latColumn, lonColumn: compositeReport.config.map.lonColumn }
          : null;

    // Generate HTML (use geocoded data for table, but original for map)
    const exportService = ExportService.getInstance();
    const html = await exportService.generateHTML({
      title: compositeReport.title,
      description: compositeReport.description,
      columns,
      rows,
      config: compositeReport.config,
      gpsColumns: includeMap ? gpsColumns : null,
      includeChart,
      executedAt: new Date(),
      chartSettings,
      mapSettings,
      ...(geocodedAddresses ? { mapColumns: queryResult.columns, mapRows: queryResult.rows } : {}),
      ...(exportPrefs.timeZone && { timeZone: exportPrefs.timeZone }),
      ...(exportPrefs.dateFormat && { dateFormat: exportPrefs.dateFormat }),
      ...(exportPrefs.timeFormat && { timeFormat: exportPrefs.timeFormat }),
    });

    // Set response headers
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', safeContentDisposition(compositeReport.slug || 'composite-report', 'html'));

    res.send(html);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/composite-reports/:id/export/pdf
 * Export composite report as PDF
 */
router.post('/composite-reports/:id/export/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }
    const { params = {}, includeChart = true, includeMap = true, geocodedAddresses, latColumn, lonColumn, gpsPairs, chartSettings, mapSettings, report_data, cachedData } = req.body;
    const { userDbUrl, userId, iotDbUrl } = getUserInfo(req);

    if (!iotDbUrl) {
      throw new CustomError('IoT database URL not configured', 400);
    }

    const dbService = DatabaseService.getInstance();
    const pool = dbService.getClientSettingsPool(userDbUrl);
    
    // Get the composite report from DB, or use report_data from request body (demo mode)
    let compositeReport = await dbService.getCompositeReportById(id, pool, userId) as CompositeReportRecord | null;
    if (!compositeReport && report_data?.sql_query) {
      compositeReport = {
        id,
        title: report_data.title || 'Report',
        description: report_data.description || '',
        slug: report_data.slug || 'report',
        sql_query: report_data.sql_query,
        config: report_data.config || {},
        section_id: null,
        sort_order: 0,
        version: 1,
        user_id: userId,
        is_deleted: false,
        created_at: new Date(),
        updated_at: new Date(),
      };
    }
    if (!compositeReport) {
      throw new CustomError('Composite report not found', 404);
    }

    // Resolved before the optional re-query so the export SQL runs in the same
    // zone the live view ran in (DO-352).
    const exportPrefs = await resolveExportPreferences(req as AuthenticatedRequest, req.body);

    // Use cached data from the frontend when available
    let queryResult: { columns: { name: string; type: string }[]; rows: unknown[][] };
    if (cachedData?.columns && cachedData?.rows) {
      queryResult = { columns: cachedData.columns, rows: cachedData.rows };
    } else {
      const { mergedParams, globalVars } = await dbService.mergeWithGlobalVars(params, pool);
      const exportTimeoutMs = resolveExportTimeoutMs(globalVars);
      const pdfExportMaxRows = compositeReport.config?.table?.maxRows || 10000;
      const result = await dbService.executeParameterizedQuery(
        compositeReport.sql_query,
        mergedParams,
        exportTimeoutMs,
        pdfExportMaxRows,
        iotDbUrl,
        undefined,
        exportPrefs.timeZone
      );
      queryResult = { columns: result.columns, rows: result.rows };
    }

    // Apply geocoded addresses if provided
    const { columns, rows } = applyGeocodedAddresses(
      queryResult.columns,
      queryResult.rows,
      geocodedAddresses,
      latColumn,
      lonColumn,
      gpsPairs
    );

    // Detect GPS columns for map (use original columns, not geocoded ones for map functionality)
    const columnInfo: ColumnInfo[] = queryResult.columns.map(col => ({
      name: col.name,
      type: col.type,
    }));
    // Only detect GPS columns when a map will actually render — otherwise skip
    // the full-row toRowObjects/validation scan (the default config has the map
    // disabled, so a plain data export shouldn't pay for it).
    const mapWanted = includeMap && compositeReport.config?.map?.enabled;
    const gpsColumns = !mapWanted
      ? null
      : compositeReport.config?.map?.autoDetect
        ? detectValidGPSColumns(columnInfo, toRowObjects(columnInfo, queryResult.rows))
        : compositeReport.config?.map?.latColumn && compositeReport.config?.map?.lonColumn
          ? { latColumn: compositeReport.config.map.latColumn, lonColumn: compositeReport.config.map.lonColumn }
          : null;

    // Generate HTML first (use geocoded data for table, but original for map)
    const exportService = ExportService.getInstance();
    const html = await exportService.generateHTML({
      title: compositeReport.title,
      description: compositeReport.description,
      columns,
      rows,
      config: compositeReport.config,
      gpsColumns: includeMap ? gpsColumns : null,
      includeChart,
      executedAt: new Date(),
      chartSettings,
      mapSettings,
      ...(geocodedAddresses ? { mapColumns: queryResult.columns, mapRows: queryResult.rows } : {}),
      ...(exportPrefs.timeZone && { timeZone: exportPrefs.timeZone }),
      ...(exportPrefs.dateFormat && { dateFormat: exportPrefs.dateFormat }),
      ...(exportPrefs.timeFormat && { timeFormat: exportPrefs.timeFormat }),
    });

    // Convert HTML to PDF
    const pdfBuffer = await exportService.generatePDF(html);

    logger.info('Exported composite report to PDF', { id, userId, size: pdfBuffer.length });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', safeContentDisposition(compositeReport.slug || 'composite-report', 'pdf'));
    res.setHeader('Content-Length', pdfBuffer.length);

    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

// Geocoding cache TTL: 30 days (addresses don't change often)
const GEOCODE_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

/**
 * Generate cache key for geocoding
 */
function getGeocodeCacheKey(lat: number, lng: number): string {
  // Round to 6 decimal places for consistent cache keys
  return `geocode:${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/**
 * POST /api/composite-reports/geocode
 * Geocode coordinates to address using Navixy API
 */
router.post('/composite-reports/geocode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { lat, lng } = req.body;
    const { sessionId } = getUserInfo(req);

    if (!sessionId) {
      throw new CustomError('Session ID (hash) is required for geocoding', 400);
    }

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw new CustomError('Invalid coordinates: lat and lng must be numbers', 400);
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new CustomError('Invalid coordinates: lat must be between -90 and 90, lng between -180 and 180', 400);
    }

    // (0,0) is the no-fix sentinel, not a geocodable place — return no address
    // gracefully (as the batch endpoint does) rather than calling the geocoder.
    if (!isDisplayableCoordinate(lat, lng)) {
      res.json({ success: true, address: null, cached: false });
      return;
    }

    // Check Redis cache first
    const cacheKey = getGeocodeCacheKey(lat, lng);
    const redisService = (await import('../services/redis.js')).RedisService.getInstance();
    const cachedAddress = await redisService.get(cacheKey);
    
    if (cachedAddress !== null) {
      logger.debug('Geocode cache hit', { lat, lng });
      res.json({
        success: true,
        address: cachedAddress,
        cached: true,
      });
      return;
    }

    const response = await fetch('https://api.eu.navixy.com/v2/geocoder/search_location', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hash: sessionId,
        location: {
          lat,
          lng,
        },
      }),
    });

    if (!response.ok) {
      throw new CustomError(`Geocoder API error: ${response.status}`, 502);
    }

    const data = await response.json();

    if (!data.success) {
      throw new CustomError('Geocoding failed', 502);
    }

    const address = data.value || null;

    // Cache the result if we got an address
    if (address) {
      await redisService.set(cacheKey, address, GEOCODE_CACHE_TTL);
      logger.debug('Geocode result cached', { lat, lng });
    }

    res.json({
      success: true,
      address,
      cached: false,
    });
  } catch (error) {
    next(error);
  }
});

const GEOCODE_CONCURRENCY = parseInt(process.env.GEOCODE_CONCURRENCY || '50', 10);
const GEOCODE_MAX_RETRIES = parseInt(process.env.GEOCODE_MAX_RETRIES || '3', 10);

interface GeocodeTask {
  lat: number;
  lng: number;
  sessionId: string;
  redisService: { get: (key: string) => Promise<string | null>; set: (key: string, value: string, ttl: number) => Promise<void>; del: (key: string) => Promise<void> };
}

interface GeocodeResult {
  lat: number;
  lng: number;
  address: string | null;
  cached: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const INVALID_ADDRESS_PATTERN = /^\d{2}\/\d{2}\/\d{2}\s\d{2}:\d{2}$/;

function isValidAddress(address: string): boolean {
  if (!address || address.length < 3) return false;
  if (INVALID_ADDRESS_PATTERN.test(address)) return false;
  if (!/[a-zA-Z\u00C0-\u024F\u0400-\u04FF]/.test(address)) return false;
  return true;
}

async function geocodeWorker(task: GeocodeTask): Promise<GeocodeResult> {
  const { lat, lng, sessionId, redisService } = task;

  const cacheKey = getGeocodeCacheKey(lat, lng);
  const cachedAddress = await redisService.get(cacheKey);

  if (cachedAddress !== null) {
    if (isValidAddress(cachedAddress)) {
      return { lat, lng, address: cachedAddress, cached: true };
    }
    logger.warn('Invalid cached geocode address, re-geocoding', { lat, lng, cachedAddress });
    await redisService.del(cacheKey);
  }

  for (let attempt = 1; attempt <= GEOCODE_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://api.eu.navixy.com/v2/geocoder/search_location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: sessionId, location: { lat, lng } }),
      });

      if (response.status === 429) {
        const delay = attempt * 1000;
        logger.warn('Geocode API rate limited, retrying', { lat, lng, attempt, delay });
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        logger.warn('Geocode API error', { lat, lng, status: response.status, attempt });
        if (attempt < GEOCODE_MAX_RETRIES) {
          await sleep(attempt * 500);
          continue;
        }
        return { lat, lng, address: null, cached: false };
      }

      const data = await response.json();
      let address = data.success ? (data.value || null) : null;

      if (!data.success) {
        logger.warn('Geocode API returned unsuccessful', { lat, lng, data });
      }

      if (address && !isValidAddress(address)) {
        logger.warn('Geocode API returned invalid address', { lat, lng, address });
        address = null;
      }

      if (address) {
        await redisService.set(cacheKey, address, GEOCODE_CACHE_TTL);
      }

      return { lat, lng, address, cached: false };
    } catch (error) {
      logger.warn('Geocode API exception', { lat, lng, attempt, error: String(error) });
      if (attempt < GEOCODE_MAX_RETRIES) {
        await sleep(attempt * 500);
        continue;
      }
      return { lat, lng, address: null, cached: false };
    }
  }

  return { lat, lng, address: null, cached: false };
}

/**
 * POST /api/composite-reports/geocode-batch
 * Geocode multiple coordinates to addresses with Redis caching and concurrent processing
 */
router.post('/composite-reports/geocode-batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { coordinates } = req.body;
    const { sessionId } = getUserInfo(req);

    if (!sessionId) {
      throw new CustomError('Session ID (hash) is required for geocoding', 400);
    }

    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      throw new CustomError('coordinates must be a non-empty array', 400);
    }

    const redisService = (await import('../services/redis.js')).RedisService.getInstance();

    logger.info('Batch geocoding started', { total: coordinates.length, concurrency: GEOCODE_CONCURRENCY, maxRetries: GEOCODE_MAX_RETRIES });

    const queue: queueAsPromised<GeocodeTask, GeocodeResult> = fastq.promise(geocodeWorker, GEOCODE_CONCURRENCY);

    const promises: Promise<GeocodeResult>[] = [];

    for (const coord of coordinates) {
      const { lat, lng } = coord;

      // Reject non-numbers, out-of-range, and the (0,0) no-fix sentinel — all
      // resolve to a null address so the batch stays graceful and null island
      // never reaches the geocoder.
      if (!isDisplayableCoordinate(lat, lng)) {
        promises.push(Promise.resolve({ lat, lng, address: null, cached: false }));
        continue;
      }

      promises.push(queue.push({ lat, lng, sessionId, redisService }));
    }

    const results = await Promise.all(promises);

    const cacheHits = results.filter(r => r.cached).length;
    const apiCalls = results.filter(r => !r.cached).length;
    const resolved = results.filter(r => r.address !== null).length;
    const failed = results.filter(r => r.address === null).length;

    logger.info('Batch geocoding completed', { total: coordinates.length, cacheHits, apiCalls, resolved, failed });

    res.json({
      success: true,
      results,
      stats: {
        total: coordinates.length,
        cacheHits,
        apiCalls,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/composite-reports/geocode-cache/clear
 * Clear all geocode cache entries from Redis
 */
router.post('/composite-reports/geocode-cache/clear', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const redisService = (await import('../services/redis.js')).RedisService.getInstance();
    const deleted = await redisService.deleteByPattern('geocode:*');
    logger.info('Geocode cache cleared', { deletedKeys: deleted });
    res.json({ success: true, deletedKeys: deleted });
  } catch (error) {
    next(error);
  }
});

export default router;

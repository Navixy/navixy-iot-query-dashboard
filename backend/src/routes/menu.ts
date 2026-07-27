import { Router } from 'express';
import { authenticateToken, requireAdminOrEditor } from '../middleware/auth.js';
import { rejectDemoWrites } from '../middleware/demoGuard.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { CustomError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ==========================================
// Menu Management API Endpoints
// ==========================================

// 1) Get current menu tree
router.get('/v1/menu/tree', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { include_deleted = 'false' } = req.query;
    const includeDeleted = include_deleted === 'true';
    const userId = req.user?.userId;

    if (!userId) {
      throw new CustomError('User not authenticated', 401);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Use the database function to get the menu tree filtered by user_id
      const result = await client.query(
        'SELECT dashboard_studio_meta_data.get_menu_tree($1, $2) as menu_tree',
        [userId, includeDeleted]
      );

      const menuTree = result.rows[0].menu_tree;

      // Normalize menu tree structure to ensure rootReports exists
      // The database function may return 'reports' instead of 'rootReports'
      if (menuTree) {
        // Ensure rootReports is an array
        if (!Array.isArray(menuTree.rootReports)) {
          // If reports exists as top-level, use it for rootReports
          if (Array.isArray(menuTree.reports)) {
            menuTree.rootReports = menuTree.reports;
          } else {
            menuTree.rootReports = [];
          }
        }
        
        // Ensure sectionReports is an object
        if (!menuTree.sectionReports || typeof menuTree.sectionReports !== 'object') {
          menuTree.sectionReports = {};
          // Build sectionReports from sections if they have embedded reports
          if (Array.isArray(menuTree.sections)) {
            for (const section of menuTree.sections) {
              if (Array.isArray(section.reports)) {
                menuTree.sectionReports[section.id] = section.reports;
              }
            }
          }
        }
        
        // Ensure sections is an array
        if (!Array.isArray(menuTree.sections)) {
          menuTree.sections = [];
        }
      }

      // Get report types to identify composite reports
      const reportTypesResult = await client.query(
        `SELECT id, report_schema->>'type' as report_type 
         FROM dashboard_studio_meta_data.reports 
         WHERE user_id = $1 AND is_deleted = FALSE`,
        [userId]
      );

      // Create a map of report id -> type
      const reportTypeMap = new Map<string, string>();
      for (const row of reportTypesResult.rows) {
        if (row.report_type) {
          reportTypeMap.set(row.id, row.report_type);
        }
      }

      logger.info('Report types found:', { 
        count: reportTypesResult.rows.length, 
        types: Object.fromEntries(reportTypeMap) 
      });

      // Add type to reports in menu tree
      if (menuTree) {
        // Handle reports inside sections
        if (Array.isArray(menuTree.sections)) {
          for (const section of menuTree.sections) {
            if (section.reports && Array.isArray(section.reports)) {
              for (const report of section.reports) {
                report.type = reportTypeMap.get(report.id) || 'standard';
              }
            }
          }
        }
        // Handle uncategorized reports
        if (Array.isArray(menuTree.uncategorized)) {
          for (const report of menuTree.uncategorized) {
            report.type = reportTypeMap.get(report.id) || 'standard';
          }
        }
        // Handle root-level reports (reports without section)
        if (Array.isArray(menuTree.rootReports)) {
          for (const report of menuTree.rootReports) {
            report.type = reportTypeMap.get(report.id) || 'standard';
          }
        }
        // Handle sectionReports (object keyed by section id: { [sectionId]: reports[] })
        if (menuTree.sectionReports && typeof menuTree.sectionReports === 'object' && !Array.isArray(menuTree.sectionReports)) {
          for (const reports of Object.values(menuTree.sectionReports)) {
            if (Array.isArray(reports)) {
              for (const report of reports) {
                report.type = reportTypeMap.get(report.id) || 'standard';
              }
            }
          }
        }
      }
      
      logger.info('Menu tree structure:', { 
        hasSections: menuTree?.sections?.length || 0,
        hasRootReports: menuTree?.rootReports?.length || 0,
        hasSectionReports: Object.keys(menuTree?.sectionReports || {}).length,
        allKeys: menuTree ? Object.keys(menuTree) : [],
        sampleRootReport: menuTree?.rootReports?.[0],
      });

      res.json(menuTree);
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// 2) Bulk reorder / move (single operation)
router.patch('/v1/menu/reorder', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    logger.info('Menu reorder request received', {
      userId: req.user?.userId,
      email: req.user?.email,
      body: req.body,
      headers: req.headers
    });

    const { sections = [], reports = [] } = req.body;

    logger.info('Parsed request data', {
      sectionsCount: sections.length,
      reportsCount: reports.length,
      sections: sections,
      reports: reports
    });

    if (!Array.isArray(sections) || !Array.isArray(reports)) {
      logger.error('Invalid request data - sections and reports must be arrays', {
        sectionsType: typeof sections,
        reportsType: typeof reports,
        sectionsIsArray: Array.isArray(sections),
        reportsIsArray: Array.isArray(reports)
      });
      throw new CustomError('Sections and reports must be arrays', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      logger.info('Starting database transaction');
      await client.query('BEGIN');

      const newVersions: Record<string, number> = {};

      // Update sections
      logger.info('Processing sections', { count: sections.length });
      for (const section of sections) {
        logger.info('Processing section', { section });
        
        if (!section.id || section.sortOrder === undefined || section.version === undefined) {
          logger.error('Invalid section data', { section });
          throw new CustomError('Each section must have id, sortOrder, and version', 400);
        }

        // Check version for optimistic concurrency (also verify user ownership)
        logger.info('Checking section version', { sectionId: section.id, expectedVersion: section.version });
        const currentResult = await client.query(
          'SELECT version FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
          [section.id, req.user?.userId]
        );

        logger.info('Section version check result', { 
          sectionId: section.id, 
          found: currentResult.rows.length > 0,
          currentVersion: currentResult.rows[0]?.version,
          expectedVersion: section.version
        });

        if (currentResult.rows.length === 0) {
          logger.error('Section not found', { sectionId: section.id });
          throw new CustomError(`Section ${section.id} not found`, 404);
        }

        if (currentResult.rows[0].version !== section.version) {
          logger.error('Section version conflict', { 
            sectionId: section.id, 
            currentVersion: currentResult.rows[0].version, 
            expectedVersion: section.version 
          });
          throw new CustomError(`Version conflict for section ${section.id}`, 409);
        }

        // Update section
        logger.info('Updating section', { sectionId: section.id, sortOrder: section.sortOrder });
        const updateResult = await client.query(
          `UPDATE dashboard_studio_meta_data.sections 
           SET sort_order = $1, version = version + 1, updated_at = NOW(), updated_by = $2
           WHERE id = $3 
           RETURNING version`,
          [section.sortOrder, req.user?.userId, section.id]
        );

        newVersions[section.id] = updateResult.rows[0].version;
        logger.info('Section updated successfully', { 
          sectionId: section.id, 
          newVersion: updateResult.rows[0].version 
        });
      }

      // Update reports
      logger.info('Processing reports', { count: reports.length });
      for (const report of reports) {
        logger.info('Processing report', { report });
        
        if (!report.id || report.sortOrder === undefined || report.version === undefined) {
          logger.error('Invalid report data', { report });
          throw new CustomError('Each report must have id, sortOrder, and version', 400);
        }

        // Check version for optimistic concurrency (also verify user ownership)
        logger.info('Checking report version', { reportId: report.id, expectedVersion: report.version });
        const currentResult = await client.query(
          'SELECT version FROM dashboard_studio_meta_data.reports WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
          [report.id, req.user?.userId]
        );

        logger.info('Report version check result', { 
          reportId: report.id, 
          found: currentResult.rows.length > 0,
          currentVersion: currentResult.rows[0]?.version,
          expectedVersion: report.version
        });

        if (currentResult.rows.length === 0) {
          logger.error('Report not found', { reportId: report.id });
          throw new CustomError(`Report ${report.id} not found`, 404);
        }

        if (currentResult.rows[0].version !== report.version) {
          logger.error('Report version conflict', { 
            reportId: report.id, 
            currentVersion: currentResult.rows[0].version, 
            expectedVersion: report.version 
          });
          throw new CustomError(`Version conflict for report ${report.id}`, 409);
        }

        // Validate parent section if provided (also verify user ownership)
        if (report.parentSectionId !== null) {
          logger.info('Validating parent section', { reportId: report.id, parentSectionId: report.parentSectionId });
          const sectionCheck = await client.query(
            'SELECT id FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
            [report.parentSectionId, req.user?.userId]
          );

          logger.info('Parent section validation result', { 
            reportId: report.id, 
            parentSectionId: report.parentSectionId,
            found: sectionCheck.rows.length > 0
          });

          if (sectionCheck.rows.length === 0) {
            logger.error('Parent section not found', { reportId: report.id, parentSectionId: report.parentSectionId });
            throw new CustomError(`Parent section ${report.parentSectionId} not found`, 422);
          }
        }

        // Update report
        logger.info('Updating report', { 
          reportId: report.id, 
          parentSectionId: report.parentSectionId, 
          sortOrder: report.sortOrder 
        });
        const updateResult = await client.query(
          `UPDATE dashboard_studio_meta_data.reports 
           SET section_id = $1, sort_order = $2, version = version + 1, updated_at = NOW(), updated_by = $3
           WHERE id = $4 
           RETURNING version`,
          [report.parentSectionId, report.sortOrder, req.user?.userId, report.id]
        );

        newVersions[report.id] = updateResult.rows[0].version;
        logger.info('Report updated successfully', { 
          reportId: report.id, 
          newVersion: updateResult.rows[0].version 
        });
      }

      logger.info('Committing transaction');
      await client.query('COMMIT');

      logger.info(`Menu reordered successfully by ${req.user?.email}`, {
        sectionsUpdated: sections.length,
        reportsUpdated: reports.length,
        newVersions
      });

      const response = {
        ok: true,
        newVersions
      };

      logger.info('Sending response', { response });
      res.json(response);
    } catch (error) {
      logger.error('Database transaction error, rolling back', { 
        error: error instanceof Error ? error.message : String(error), 
        stack: error instanceof Error ? error.stack : undefined 
      });
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Menu reorder endpoint error', { 
      error: error instanceof Error ? error.message : String(error), 
      stack: error instanceof Error ? error.stack : undefined,
      userId: req.user?.userId,
      email: req.user?.email
    });
    next(error);
  }
});

// 3) Rename section
router.patch('/v1/sections/:id', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    const { name, version } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new CustomError('Name is required and must be non-empty', 400);
    }

    if (version === undefined) {
      throw new CustomError('Version is required for optimistic concurrency', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Check version for optimistic concurrency (also verify user ownership)
      const currentResult = await client.query(
        'SELECT version FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
        [id, req.user?.userId]
      );

      if (currentResult.rows.length === 0) {
        throw new CustomError('Section not found', 404);
      }

      if (currentResult.rows[0].version !== version) {
        throw new CustomError('Version conflict', 409);
      }

      // Update section
      const result = await client.query(
        `UPDATE dashboard_studio_meta_data.sections 
         SET name = $1, version = version + 1, updated_at = NOW(), updated_by = $2
         WHERE id = $3 
         RETURNING id, name, version`,
        [name.trim(), req.user?.userId, id]
      );

      logger.info(`Section renamed by ${req.user?.email}: ${name}`);

      res.json({
        ok: true,
        section: result.rows[0]
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// 4) Rename report
router.patch('/v1/reports/:id', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    const { name, version } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new CustomError('Name is required and must be non-empty', 400);
    }

    if (version === undefined) {
      throw new CustomError('Version is required for optimistic concurrency', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Check version for optimistic concurrency (also verify user ownership)
      const currentResult = await client.query(
        'SELECT version FROM dashboard_studio_meta_data.reports WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
        [id, req.user?.userId]
      );

      if (currentResult.rows.length === 0) {
        throw new CustomError('Report not found', 404);
      }

      if (currentResult.rows[0].version !== version) {
        throw new CustomError('Version conflict', 409);
      }

      // Update report
      const result = await client.query(
        `UPDATE dashboard_studio_meta_data.reports 
         SET title = $1, version = version + 1, updated_at = NOW(), updated_by = $2
         WHERE id = $3 
         RETURNING id, title as name, version`,
        [name.trim(), req.user?.userId, id]
      );

      logger.info(`Report renamed by ${req.user?.email}: ${name}`);

      res.json({
        ok: true,
        report: result.rows[0]
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// 5) Soft-delete section (with strategy)
router.patch('/v1/sections/:id/delete', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    const { strategy } = req.body;

    if (!strategy || !['move_children_to_root', 'delete_children'].includes(strategy)) {
      throw new CustomError('Strategy must be either "move_children_to_root" or "delete_children"', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      await client.query('BEGIN');

      // Check if section exists (also verify user ownership)
      const sectionResult = await client.query(
        'SELECT id, name FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
        [id, req.user?.userId]
      );

      if (sectionResult.rows.length === 0) {
        throw new CustomError('Section not found', 404);
      }

      const sectionName = sectionResult.rows[0].name;

      // Get child reports (verify user ownership)
      const reportsResult = await client.query(
        'SELECT id FROM dashboard_studio_meta_data.reports WHERE section_id = $1 AND user_id = $2 AND is_deleted = FALSE',
        [id, req.user?.userId]
      );

      const childReports = reportsResult.rows;
      let affectedReports = 0;

      if (childReports.length > 0) {
        if (strategy === 'move_children_to_root') {
          // Move reports to root and reassign sort orders
          await client.query(
            'UPDATE dashboard_studio_meta_data.reports SET section_id = NULL WHERE section_id = $1 AND is_deleted = FALSE',
            [id]
          );

          // Renumber root reports
          await client.query('SELECT renumber_sort_orders(NULL)');
          affectedReports = childReports.length;

          logger.info(`Moved ${childReports.length} reports from section "${sectionName}" to root`);
        } else {
          // Soft delete all child reports
          await client.query(
            'UPDATE dashboard_studio_meta_data.reports SET is_deleted = TRUE, updated_at = NOW(), updated_by = $1 WHERE section_id = $2 AND is_deleted = FALSE',
            [req.user?.userId, id]
          );
          affectedReports = childReports.length;

          logger.info(`Soft deleted ${childReports.length} reports from section "${sectionName}"`);
        }
      }

      // Soft delete the section
      // The trigger function handles recursion prevention internally
      await client.query(
        'UPDATE dashboard_studio_meta_data.sections SET is_deleted = TRUE, updated_at = NOW(), updated_by = $1 WHERE id = $2',
        [req.user?.userId, id]
      );

      await client.query('COMMIT');

      logger.info(`Section soft deleted by ${req.user?.email}: ${sectionName}`);

      res.json({
        ok: true,
        affectedReports
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// 6) Soft-delete report
router.patch('/v1/reports/:id/delete', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Check if report exists (also verify user ownership)
      const reportResult = await client.query(
        'SELECT id, title FROM dashboard_studio_meta_data.reports WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE',
        [id, req.user?.userId]
      );

      if (reportResult.rows.length === 0) {
        throw new CustomError('Report not found', 404);
      }

      const reportTitle = reportResult.rows[0].title;

      // Soft delete the report
      await client.query(
        'UPDATE dashboard_studio_meta_data.reports SET is_deleted = TRUE, updated_at = NOW(), updated_by = $1 WHERE id = $2',
        [req.user?.userId, id]
      );

      logger.info(`Report soft deleted by ${req.user?.email}: ${reportTitle}`);

      res.json({
        ok: true
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Optional: Restore section (for future admin functionality)
router.patch('/v1/sections/:id/restore', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Check if section exists and is deleted (also verify user ownership)
      const sectionResult = await client.query(
        'SELECT id, name FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2 AND is_deleted = TRUE',
        [id, req.user?.userId]
      );

      if (sectionResult.rows.length === 0) {
        throw new CustomError('Deleted section not found', 404);
      }

      const sectionName = sectionResult.rows[0].name;

      // Restore the section
      await client.query(
        'UPDATE dashboard_studio_meta_data.sections SET is_deleted = FALSE, updated_at = NOW(), updated_by = $1 WHERE id = $2',
        [req.user?.userId, id]
      );

      logger.info(`Section restored by ${req.user?.email}: ${sectionName}`);

      res.json({
        ok: true
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Optional: Restore report (for future admin functionality)
router.patch('/v1/reports/:id/restore', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Check if report exists and is deleted (also verify user ownership)
      const reportResult = await client.query(
        'SELECT id, title FROM dashboard_studio_meta_data.reports WHERE id = $1 AND user_id = $2 AND is_deleted = TRUE',
        [id, req.user?.userId]
      );

      if (reportResult.rows.length === 0) {
        throw new CustomError('Deleted report not found', 404);
      }

      const reportTitle = reportResult.rows[0].title;

      // Restore the report
      await client.query(
        'UPDATE dashboard_studio_meta_data.reports SET is_deleted = FALSE, updated_at = NOW(), updated_by = $1 WHERE id = $2',
        [req.user?.userId, id]
      );

      logger.info(`Report restored by ${req.user?.email}: ${reportTitle}`);

      res.json({
        ok: true
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

export default router;

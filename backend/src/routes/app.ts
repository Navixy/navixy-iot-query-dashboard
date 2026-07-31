import { Router } from 'express';
import { DatabaseService } from '../services/database.js';
import {
  readUserPreferences,
  validatePreferencesPatch,
  writeUserPreferences,
  type UserPreferences,
} from '../services/userPreferences.js';
import { authenticateToken, requireAdmin, requireAdminOrEditor } from '../middleware/auth.js';
import { rejectDemoWrites } from '../middleware/demoGuard.js';
import { assertDemoCleanupAllowed, deleteEphemeralDemoUser } from '../services/demoUserCleanup.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { CustomError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = Router();

// ==========================================
// Authentication Routes
// ==========================================

// Login (passwordless only - for plugin mode)
// Accepts optional 'demo' field to indicate demo mode
// Accepts optional 'session_id' field for session tracking
router.post('/auth/login', async (req, res, next) => {
  try {
    const { email, role, iotDbUrl, userDbUrl, demo, session_id } = req.body;

    // Passwordless authentication only
    if (!email || !role || !iotDbUrl || !userDbUrl) {
      throw new CustomError('Email, role, iotDbUrl, and userDbUrl are required', 400);
    }

    if (!['admin', 'editor', 'viewer'].includes(role)) {
      throw new CustomError('Invalid role. Must be admin, editor, or viewer', 400);
    }

    const isDemoMode = demo === true || demo === 'true';
    // Accept session_id as string or convert to string if provided
    const sessionId = session_id !== undefined && session_id !== null ? String(session_id) : undefined;

    // Mask password in URL for logging: show scheme, user, host, db but mask password
    const maskedUserDbUrl = userDbUrl?.replace(/:([^@]+)@/, ':<MASKED>@') ?? 'undefined';
    logger.info('Login attempt (passwordless)', { 
      email, 
      role, 
      demo: isDemoMode,
      session_id: sessionId ?? 'not provided',
      userDbUrl: maskedUserDbUrl,
      userDbUrlLength: userDbUrl?.length,
    });

    const dbService = DatabaseService.getInstance();
    const result = await dbService.authenticateUserPasswordless(
      email,
      role as 'admin' | 'editor' | 'viewer',
      iotDbUrl,
      userDbUrl,
      isDemoMode,
      sessionId
    );

    logger.info(`User logged in (passwordless): ${email}`, { demo: isDemoMode, session_id: sessionId ?? 'not provided' });

    let preferences: UserPreferences | undefined;
    try {
      const settingsPool = dbService.getClientSettingsPool(userDbUrl);
      preferences = await readUserPreferences(settingsPool, result.user.id);
    } catch {
      // Non-critical; frontend will fall back to defaults.
    }

    res.json({
      success: true,
      user: {
        id: result.user.id,
        email: result.user.email,
        // The role the account ACTUALLY holds — the SAME value the JWT carries
        // (review !62 round 13, Important 3). Echoing the requested `role` here
        // let the UI and the token disagree: AuthContext stores this object, so a
        // demo login asking for 'admin' on a viewer account showed admin-only
        // affordances that every API call would then reject.
        role: result.effectiveRole
      },
      token: result.token,
      demo: isDemoMode,
      ...(preferences && { preferences }),
    });
  } catch (error) {
    logger.error('Login error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    next(error);
  }
});

// Get current user info (verify token)
router.get('/auth/me', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    let preferences: UserPreferences | undefined;
    if (req.settingsPool && req.user?.userId) {
      try {
        preferences = await readUserPreferences(req.settingsPool, req.user.userId);
      } catch {
        // Non-critical; frontend will fall back to defaults.
      }
    }

    res.json({
      success: true,
      user: {
        id: req.user?.userId,
        email: req.user?.email,
        role: req.user?.role
      },
      ...(preferences && { preferences }),
    });
  } catch (error) {
    next(error);
  }
});

// Delete demo user after data has been seeded to IndexedDB
// This cleans up temporary demo users from the database
router.delete('/auth/demo-user', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const userId = req.user?.userId;
    if (!userId) {
      throw new CustomError('User ID not found', 400);
    }

    // THIS ENDPOINT DELETES A USER AND ALL THEIR SECTIONS AND REPORTS. It is
    // excluded from rejectDemoWrites because the demo flow itself calls it — so
    // it carries its own, STRICTER guard (review !62 round 11, Critical 1). The
    // decision and the row match live in services/demoUserCleanup.ts, where they
    // are unit-testable; see there for why each condition exists.
    const cleanupToken = assertDemoCleanupAllowed(req.user);

    const client = await req.settingsPool.connect();

    try {
      await client.query('BEGIN');
      const deleted = await deleteEphemeralDemoUser(client, userId, cleanupToken);
      await client.query('COMMIT');

      if (deleted) {
        logger.info('Demo user deleted successfully', { userId, email: req.user?.email });
      }

      // A skipped cleanup is a NO-OP, not an error: the row was adopted by a real
      // login, or a previous attempt already removed it. The client treats both
      // the same way, so there is nothing for it to recover from.
      res.json({
        success: true,
        deleted,
        message: deleted ? 'Demo user deleted successfully' : 'Demo user cleanup skipped',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Error deleting demo user:', error);
    next(error);
  }
});

// Test IoT database connection (public endpoint, no auth required)
router.post('/auth/test-iot-connection', async (req, res, next) => {
  try {
    const { db_url, db_host, db_port, db_name, db_user, db_password, db_ssl } = req.body;

    const dbService = DatabaseService.getInstance();
    
    const testSettings = {
      external_db_url: db_url,
      external_db_host: db_host,
      external_db_port: db_port,
      external_db_name: db_name,
      external_db_user: db_user,
      external_db_password: db_password,
      external_db_ssl: db_ssl
    };

    // Test the connection
    try {
      await dbService.testDatabaseConnection(testSettings);
      
      res.json({
        success: true,
        message: 'IoT database connection successful'
      });
    } catch (error) {
      if (error instanceof CustomError) {
        throw error;
      }
      throw new CustomError(
        `Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        400
      );
    }
  } catch (error) {
    next(error);
  }
});

// ==========================================
// User Preferences Routes
// ==========================================
// Storage shape and merge semantics live in services/userPreferences.ts.

router.get('/user/preferences', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.user?.userId) {
      throw new CustomError('User ID not found', 400);
    }
    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const prefs = await readUserPreferences(req.settingsPool, req.user.userId);
    res.json(prefs);
  } catch (error) {
    next(error);
  }
});

router.put('/user/preferences', authenticateToken, rejectDemoWrites, async (req: AuthenticatedRequest, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Field validation (incl. sanitizeTimeZone on `timezone` — the same rules
    // as the SQL session zone) lives in validatePreferencesPatch; it throws
    // CustomError(400) with a field-specific message.
    const patch = validatePreferencesPatch(body);

    if (!req.user?.userId) {
      throw new CustomError('User ID not found', 400);
    }
    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const saved = await writeUserPreferences(req.settingsPool, req.user.userId, patch);
    if (saved == null) {
      // Row not found - the JWT references a user that no longer exists in
      // the metadata DB. Surface explicitly instead of silently 200ing.
      throw new CustomError('User record not found', 404);
    }

    logger.info(
      `User preferences updated by ${req.user.email}: ` +
        Object.entries(patch)
          .map(([k, v]) => `${k}=${v}`)
          .join(', '),
    );
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// Global Variables Routes
// ==========================================

// Get all global variables
router.get('/global-variables', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    const variables = await dbService.getGlobalVariables(req.settingsPool);

    res.json({
      success: true,
      variables
    });
  } catch (error) {
    next(error);
  }
});

// Get global variable by ID
router.get('/global-variables/:id', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new CustomError('Variable ID is required', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    const variable = await dbService.getGlobalVariableById(id as string, req.settingsPool);

    if (!variable) {
      throw new CustomError('Global variable not found', 404);
    }

    res.json({
      success: true,
      variable
    });
  } catch (error) {
    next(error);
  }
});

// Create global variable (admin only)
router.post('/global-variables', authenticateToken, rejectDemoWrites, requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { label, description, value } = req.body;

    if (!label) {
      throw new CustomError('Label is required', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    const variable = await dbService.createGlobalVariable({
      label,
      description,
      value
    }, req.settingsPool);
    await dbService.invalidateGlobalVarsCache(req.settingsPool);

    logger.info(`Global variable created by ${req.user?.email}: ${label}`);

    res.status(201).json({
      success: true,
      variable
    });
  } catch (error) {
    next(error);
  }
});

// Update global variable (admin only)
router.put('/global-variables/:id', authenticateToken, rejectDemoWrites, requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new CustomError('Variable ID is required', 400);
    }
    const { label, description, value } = req.body;

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    const variable = await dbService.updateGlobalVariable(id as string, {
      label,
      description,
      value
    }, req.settingsPool);
    await dbService.invalidateGlobalVarsCache(req.settingsPool);

    logger.info(`Global variable updated by ${req.user?.email}: ${variable.label}`);

    res.json({
      success: true,
      variable
    });
  } catch (error) {
    next(error);
  }
});

// Delete global variable (admin only)
router.delete('/global-variables/:id', authenticateToken, rejectDemoWrites, requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new CustomError('Variable ID is required', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    await dbService.deleteGlobalVariable(id as string, req.settingsPool);
    await dbService.invalidateGlobalVarsCache(req.settingsPool);

    logger.info(`Global variable deleted by ${req.user?.email}: ${id}`);

    res.json({
      success: true,
      message: 'Global variable deleted successfully'
    });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// Reports and Sections Routes
// ==========================================

// Get all sections (filtered by user_id)
router.get('/sections', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    const sections = await dbService.getSections(req.settingsPool, req.user?.userId);

    logger.info('GET /sections response', {
      userId: req.user?.userId,
      count: sections.length,
      sectionNames: sections.map((s: Record<string, unknown>) => s.name)
    });

    res.json({
      success: true,
      sections
    });
  } catch (error) {
    next(error);
  }
});

// Get all reports (filtered by user_id)
router.get('/reports', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    const reports = await dbService.getReports(req.settingsPool, req.user?.userId);

    logger.info('GET /reports response', {
      userId: req.user?.userId,
      count: reports.length,
      reportTitles: reports.map((r: Record<string, unknown>) => r.title)
    });

    res.json({
      success: true,
      reports
    });
  } catch (error) {
    next(error);
  }
});

// Get report by ID (filtered by user_id)
router.get('/reports/:id', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      throw new CustomError('Report ID is required', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const dbService = DatabaseService.getInstance();
    const report = await dbService.getReportById(id, req.settingsPool, req.user?.userId);

    if (!report) {
      throw new CustomError('Report not found', 404);
    }

    res.json({
      success: true,
      report
    });
  } catch (error) {
    next(error);
  }
});

// Create section (admin/editor only)
router.post('/sections', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { name, sort_order } = req.body;
    
    if (!name) {
      throw new CustomError('Section name is required', 400);
    }

    if (!req.user?.userId) {
      throw new CustomError('User not authenticated', 401);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      const result = await client.query(
        'INSERT INTO dashboard_studio_meta_data.sections (name, sort_order, user_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, sort_order || 0, req.user.userId, req.user.userId]
      );

      logger.info(`Section created by ${req.user?.email}: ${name}`);

      res.status(201).json({
        success: true,
        section: result.rows[0]
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Update section (admin/editor only)
router.put('/sections/:id', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    const { name, sort_index } = req.body;
    
    if (!name) {
      throw new CustomError('Section name is required', 400);
    }

    if (!req.user?.userId) {
      throw new CustomError('User not authenticated', 401);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Verify user owns this section
      const ownerCheck = await client.query(
        'SELECT id FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );
      if (ownerCheck.rows.length === 0) {
        throw new CustomError('Section not found or access denied', 404);
      }

      const updateFields = ['name = $1'];
      const updateValues = [name];
      let paramIndex = 2;

      if (sort_index !== undefined) {
        updateFields.push(`sort_index = $${paramIndex}`);
        updateValues.push(sort_index);
        paramIndex++;
      }

      const result = await client.query(
        `UPDATE dashboard_studio_meta_data.sections SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        [...updateValues, id]
      );

      if (result.rows.length === 0) {
        throw new CustomError('Section not found', 404);
      }

      logger.info(`Section updated by ${req.user?.email}: ${name}`);

      res.json({
        success: true,
        section: result.rows[0]
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Delete section (admin/editor only)
router.delete('/sections/:id', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    const { moveReportsToSection } = req.query; // Optional: move reports to another section

    if (!req.user?.userId) {
      throw new CustomError('User not authenticated', 401);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      await client.query('BEGIN');

      // First check if section exists and user owns it
      const checkResult = await client.query(
        'SELECT id, name FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );

      if (checkResult.rows.length === 0) {
        throw new CustomError('Section not found', 404);
      }

      const sectionName = checkResult.rows[0].name;

      // Get reports in this section
      const reportsResult = await client.query(
        'SELECT id, title FROM dashboard_studio_meta_data.reports WHERE section_id = $1',
        [id]
      );

      const reportsInSection = reportsResult.rows;

      if (reportsInSection.length > 0) {
        if (moveReportsToSection) {
          // Move reports to another section (verify user owns target section)
          const targetSectionResult = await client.query(
            'SELECT id FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2',
            [moveReportsToSection, req.user.userId]
          );

          if (targetSectionResult.rows.length === 0) {
            throw new CustomError('Target section not found', 404);
          }

          await client.query(
            'UPDATE dashboard_studio_meta_data.reports SET section_id = $1 WHERE section_id = $2',
            [moveReportsToSection, id]
          );

          logger.info(`Moved ${reportsInSection.length} reports from section "${sectionName}" to section ${moveReportsToSection}`);
        } else {
          // Move reports to root (no section)
          await client.query(
            'UPDATE dashboard_studio_meta_data.reports SET section_id = NULL WHERE section_id = $1',
            [id]
          );

          logger.info(`Moved ${reportsInSection.length} reports from section "${sectionName}" to root`);
        }
      }

      // Delete the section
      const deleteResult = await client.query(
        'DELETE FROM dashboard_studio_meta_data.sections WHERE id = $1 RETURNING id',
        [id]
      );

      if (deleteResult.rows.length === 0) {
        throw new CustomError('Failed to delete section', 500);
      }

      await client.query('COMMIT');

      logger.info(`Section deleted by ${req.user?.email}: ${sectionName} (ID: ${id})`);

      res.json({
        success: true,
        message: 'Section deleted successfully',
        movedReports: reportsInSection.length
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

// Reorder sections (admin/editor only)
router.put('/sections/reorder', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { sections } = req.body; // Array of { id, sort_index }
    
    if (!Array.isArray(sections)) {
      throw new CustomError('Sections array is required', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      await client.query('BEGIN');

      for (const section of sections) {
        if (!section.id || section.sort_index === undefined) {
          throw new CustomError('Each section must have id and sort_index', 400);
        }

        await client.query(
          'UPDATE dashboard_studio_meta_data.sections SET sort_index = $1 WHERE id = $2',
          [section.sort_index, section.id]
        );
      }

      await client.query('COMMIT');

      logger.info(`Sections reordered by ${req.user?.email}`);

      res.json({
        success: true,
        message: 'Sections reordered successfully'
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

// Reorder reports (admin/editor only)
router.put('/reports/reorder', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { reports } = req.body; // Array of { id, sort_index, section_id }
    
    if (!Array.isArray(reports)) {
      throw new CustomError('Reports array is required', 400);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      await client.query('BEGIN');

      for (const report of reports) {
        if (!report.id || report.sort_index === undefined) {
          throw new CustomError('Each report must have id and sort_index', 400);
        }

        const updateFields = ['sort_index = $1'];
        const updateValues = [report.sort_index];
        let paramIndex = 2;

        if (report.section_id !== undefined) {
          updateFields.push(`section_id = $${paramIndex}`);
          updateValues.push(report.section_id);
          paramIndex++;
        }

        await client.query(
          `UPDATE dashboard_studio_meta_data.reports SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
          [...updateValues, report.id]
        );
      }

      await client.query('COMMIT');

      logger.info(`Reports reordered by ${req.user?.email}`);

      res.json({
        success: true,
        message: 'Reports reordered successfully'
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

// Create report (admin/editor only)
router.post('/reports', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { title, section_id, slug, sort_order, report_schema } = req.body;
    
    if (!title || !report_schema) {
      throw new CustomError('Report title and schema are required', 400);
    }

    if (!req.user?.userId) {
      throw new CustomError('User not authenticated', 401);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // If section_id is provided, verify it belongs to the user
      if (section_id) {
        const sectionCheck = await client.query(
          'SELECT id FROM dashboard_studio_meta_data.sections WHERE id = $1 AND user_id = $2',
          [section_id, req.user.userId]
        );
        if (sectionCheck.rows.length === 0) {
          throw new CustomError('Section not found or access denied', 404);
        }
      }

      const result = await client.query(
        `INSERT INTO dashboard_studio_meta_data.reports (title, section_id, slug, sort_order, report_schema, user_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          title,
          section_id,
          slug || title.toLowerCase().replace(/\s+/g, '-'),
          sort_order || 0,
          JSON.stringify(report_schema),
          req.user.userId,
          req.user.userId,
          req.user.userId
        ]
      );

      logger.info(`Report created by ${req.user?.email}: ${title}`);

      res.status(201).json({
        success: true,
        report: result.rows[0]
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Update report (admin/editor only)
router.put('/reports/:id', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;
    const { title, subtitle, report_schema } = req.body;
    
    if (!title) {
      throw new CustomError('Report title is required', 400);
    }

    if (!req.user?.userId) {
      throw new CustomError('User not authenticated', 401);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // Verify user owns this report
      const ownerCheck = await client.query(
        'SELECT id FROM dashboard_studio_meta_data.reports WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );
      if (ownerCheck.rows.length === 0) {
        throw new CustomError('Report not found or access denied', 404);
      }

      const updateFields = ['title = $1', 'updated_by = $2', 'updated_at = NOW()'];
      const updateValues = [title, req.user?.userId];
      let paramIndex = 3;

      if (subtitle !== undefined) {
        updateFields.push(`subtitle = $${paramIndex}`);
        updateValues.push(subtitle);
        paramIndex++;
      }

      if (report_schema) {
        const schemaJson = JSON.stringify(report_schema);
        updateFields.push(`report_schema = $${paramIndex}`);
        updateValues.push(schemaJson);
        paramIndex++;
      }

      const updateQuery = `UPDATE dashboard_studio_meta_data.reports SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

      const result = await client.query(
        updateQuery,
        [...updateValues, id]
      );

      if (result.rows.length === 0) {
        throw new CustomError('Report not found', 404);
      }

      const savedReport = result.rows[0];
      logger.info(`Report updated by ${req.user?.email}: ${title}`);

      res.json({
        success: true,
        report: savedReport
      });
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Error updating report:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      reportId: req.params.id,
    });
    next(error);
  }
});

// Delete report (admin/editor only)
router.delete('/reports/:id', authenticateToken, rejectDemoWrites, requireAdminOrEditor, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { id } = req.params;

    if (!req.user?.userId) {
      throw new CustomError('User not authenticated', 401);
    }

    if (!req.settingsPool) {
      throw new CustomError('Settings pool not available', 500);
    }

    const client = await req.settingsPool.connect();
    
    try {
      // First check if report exists and user owns it
      const checkResult = await client.query(
        'SELECT id, title FROM dashboard_studio_meta_data.reports WHERE id = $1 AND user_id = $2',
        [id, req.user.userId]
      );

      if (checkResult.rows.length === 0) {
        throw new CustomError('Report not found', 404);
      }

      const reportTitle = checkResult.rows[0].title;

      // Delete the report
      const deleteResult = await client.query(
        'DELETE FROM dashboard_studio_meta_data.reports WHERE id = $1 RETURNING id',
        [id]
      );

      if (deleteResult.rows.length === 0) {
        throw new CustomError('Failed to delete report', 500);
      }

      logger.info(`Report deleted by ${req.user?.email}: ${reportTitle} (ID: ${id})`);

      res.json({
        success: true,
        message: 'Report deleted successfully'
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Get example report schema (public endpoint)
router.get('/schema/example', async (req, res, next) => {
  try {
    let schemaUrl = process.env.REPORT_SCHEMA_URL;
    
    if (!schemaUrl) {
      throw new CustomError('Schema URL not configured', 500);
    }

    // Fix GitHub raw URL format: replace refs/heads/main with main
    if (schemaUrl.includes('raw.githubusercontent.com') && schemaUrl.includes('refs/heads/')) {
      schemaUrl = schemaUrl.replace('/refs/heads/', '/');
      logger.info('Fixed GitHub raw URL format', { original: process.env.REPORT_SCHEMA_URL, fixed: schemaUrl });
    }

    const response = await fetch(schemaUrl);
    
    if (!response.ok) {
      const errorMessage = `Failed to fetch schema from ${schemaUrl}: ${response.status} ${response.statusText}`;
      logger.error(errorMessage);
      throw new CustomError(errorMessage, response.status);
    }

    const schema = await response.json();
    
    logger.info('Example schema fetched successfully', { url: schemaUrl });
    
    res.json({
      success: true,
      schema
    });
  } catch (error) {
    if (error instanceof CustomError) {
      next(error);
    } else {
      logger.error('Error fetching example schema:', error);
      next(new CustomError(`Failed to fetch schema: ${error instanceof Error ? error.message : 'Unknown error'}`, 500));
    }
  }
});

// Get schema configuration (public endpoint)
router.get('/schema/config', async (req, res, next) => {
  try {
    let schemaUrl = process.env.REPORT_SCHEMA_URL;
    
    // Fix GitHub raw URL format: replace refs/heads/main with main
    if (schemaUrl && schemaUrl.includes('raw.githubusercontent.com') && schemaUrl.includes('refs/heads/')) {
      schemaUrl = schemaUrl.replace('/refs/heads/', '/');
    }
    
    res.json({
      success: true,
      defaultUrl: schemaUrl || ''
    });
  } catch (error) {
    next(error);
  }
});

export default router;

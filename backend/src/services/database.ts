import { Pool } from 'pg';
import type { PoolClient, FieldDef } from 'pg';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { CustomError } from '../middleware/errorHandler.js';
import { SQLSelectGuard } from '../utils/sqlSelectGuard.js';
import { RedisService } from './redis.js';
import jwt from 'jsonwebtoken';
import { toErrorMeta, isTransientDbError, type ErrorWithMeta } from '../utils/errors.js';
import { buildAuthTokenPayload } from './authTokenPayload.js';
import { resolveLoginIdentity } from './passwordlessLogin.js';
import { sanitizeTimeZone } from '../utils/datetime.js';
import {
  parsePostgresUrl as parseDbUrl,
  settingsPoolKey,
  type DatabaseConfig,
} from './dbIdentity.js';
import { configurePgTypeParsers } from '../utils/pgTypeParsers.js';

// Applied before the first pool is built: value parsing is a property of the
// pg module, not of a connection, and every query in the process goes through
// this service (DO-273).
configurePgTypeParsers();

export type { DatabaseConfig } from './dbIdentity.js';


export interface QueryResult {
  columns: string[];
  rows: unknown[];
  columnTypes: Record<string, string>;
  total: number;
  page: number;
  pageSize: number;
}

export interface TileResult {
  value: number | null;
}

export interface ParameterizedQueryResult {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  stats: {
    rowCount: number;
    elapsedMs: number;
    usedParamCount?: number;
  };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export interface User {
  id: string;
  email: string;
  email_confirmed_at?: string;
  created_at: string;
  updated_at: string;
  last_sign_in_at?: string;
  raw_user_meta_data?: Record<string, unknown>;
  raw_app_meta_data?: Record<string, unknown>;
  is_super_admin: boolean;
}

export interface UserRole {
  user_id: string;
  role: 'admin' | 'editor' | 'viewer';
  created_at: string;
}

export class DatabaseService {
  private static instance: DatabaseService;
  private clientSettingsPools: Map<string, { pool: Pool; password: string }> = new Map();
  private externalPools: Map<string, { pool: Pool; password: string }> = new Map();
  // Pool -> its tenant pool key (user@host:port/database). Used to build a
  // per-tenant cache key without depending on pg's internal `pool.options`,
  // which is empty when a pool is built from a connectionString and would
  // otherwise collapse every tenant onto one cache entry.
  private settingsPoolKeys: WeakMap<Pool, string> = new WeakMap();

  constructor() {
    logger.info('Database service initialized (client settings mode)');
  }

  /**
   * Wraps a Pool so that every client acquired via connect() automatically
   * gets an 'error' event handler, preventing unhandled errors from crashing
   * the process when a checked-out client's connection drops between queries.
   */
  private wrapPool(pool: Pool, label: string): Pool {
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async (): Promise<PoolClient> => {
      const client = await originalConnect();
      const onError = (err: Error) => {
        logger.error('Error on checked-out pg client', { label, error: err.message });
      };
      client.on('error', onError);
      const originalRelease = client.release.bind(client);
      client.release = (err?: boolean | Error) => {
        client.removeListener('error', onError);
        return originalRelease(err);
      };
      return client;
    };
    return pool;
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  static async initialize(): Promise<void> {
    // Just create the instance - no connection to test without iotDbUrl
    DatabaseService.getInstance();
    logger.info('Database service ready (will connect on first request)');
  }

  // ==========================================
  // Client Settings Pool Management
  // ==========================================

  /**
   * Parse a PostgreSQL URL and extract connection components.
   * Delegates to dbIdentity.ts (MR !61 round 3), where the SAME normalization
   * also feeds settingsPoolKey — the pool cache key and the chat tenant key must
   * come from one construction site or they drift (note 56573).
   */
  parsePostgresUrl(url: string): DatabaseConfig {
    return parseDbUrl(url);
  }

  /**
   * Get or create a client settings pool for the given userDbUrl
   * Uses the userDbUrl directly (no transformation)
   */
  getClientSettingsPool(userDbUrl: string): Pool {
    const config = this.parsePostgresUrl(userDbUrl);
    const poolKey = settingsPoolKey(config);

    const existing = this.clientSettingsPools.get(poolKey);
    if (existing && existing.password !== config.password) {
      // The EVENT is the signal — never log password fragments, even truncated
      // ones (MR !61 round 4, note 56582).
      logger.info('Password changed for client settings pool, recreating', { poolKey });
      existing.pool.end().catch(err => {
        logger.error('Error closing stale client settings pool', { poolKey, error: err.message });
      });
      this.clientSettingsPools.delete(poolKey);
    }

    if (!this.clientSettingsPools.has(poolKey)) {
      const sslConfig = config.ssl ? { rejectUnauthorized: false } : false;
      logger.info('Creating client settings pool', {
        poolKey,
        user: config.user,
        host: config.hostname,
        port: config.port,
        database: config.database,
        ssl: config.ssl,
        sslConfig: JSON.stringify(sslConfig),
      });

      const pool = new Pool({
        user: config.user,
        password: config.password,
        database: config.database,
        host: config.hostname,
        port: config.port,
        ssl: sslConfig,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      pool.on('error', (err) => {
        logger.error('Unexpected error on idle client settings pool client', { poolKey, error: err.message });
      });

      this.wrapPool(pool, poolKey);
      this.clientSettingsPools.set(poolKey, { pool, password: config.password });
      logger.info('Created new client settings pool', { poolKey });
    } else {
      logger.info('Reusing existing client settings pool', { poolKey });
    }

    const pool = this.clientSettingsPools.get(poolKey)!.pool;
    // Record the tenant identity for this pool instance so per-tenant caching
    // (e.g. global variables) can key off it reliably.
    this.settingsPoolKeys.set(pool, poolKey);
    return pool;
  }

  /**
   * Test client settings database connection
   */
  async testClientSettingsConnection(userDbUrl: string): Promise<void> {
    const pool = this.getClientSettingsPool(userDbUrl);
    let client: PoolClient | null = null;

    try {
      client = await pool.connect();
      await client.query('SELECT 1');
      logger.info('Client settings database connection successful');
    } catch (error) {
      logger.error('Failed to connect to client settings database:', error);
      throw new CustomError(
        `Failed to connect to client settings database: ${error instanceof Error ? error.message : 'Unknown error'}`,
        500
      );
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // ==========================================
  // Authentication Methods
  // ==========================================

  /**
   * Passwordless authentication for plugin mode
   * Creates or updates user in client database and returns JWT
   * @param demo - If true, enables demo mode where settings are stored locally
   * @param sessionId - Optional session identifier for tracking
   */
  async authenticateUserPasswordless(
    email: string,
    role: 'admin' | 'editor' | 'viewer',
    iotDbUrl: string,
    userDbUrl: string,
    demo: boolean = false,
    sessionId?: string
  ): Promise<{ user: User; token: string; effectiveRole: 'admin' | 'editor' | 'viewer' }> {
    const pool = this.getClientSettingsPool(userDbUrl);

    try {
      const client = await pool.connect();

      try {
        // Get-or-create, the role/metadata writes, the marker and therefore the
        // JWT all happen in ONE transaction, serialized per email address —
        // see services/passwordlessLogin.ts for the races that required it
        // (review !62 round 12, Critical 1). It lives there rather than inline
        // because this module cannot be imported under the repo's ts-jest ESM
        // setup, which is why none of this was testable before.
        const { user, isNewUser, effectiveRole, demoCleanupToken } =
          await resolveLoginIdentity(client, { email, role, iotDbUrl, userDbUrl, demo });

        logger.info('Updated user metadata with database URLs', {
          userId: user.id,
          email,
          isNewUser,
          session_id: sessionId ?? 'not provided',
        });

        // Generate JWT token - include both URLs, demo flag, and optional session_id
        // for subsequent requests. buildAuthTokenPayload also adds the per-login jti
        // that makes every token unique (review !62 round 10, Important 4) — see
        // services/authTokenPayload.ts for why that is load-bearing.
        const tokenPayload = buildAuthTokenPayload({
          userId: user.id,
          email: user.email,
          // The role the account ACTUALLY holds. For a demo login on a
          // pre-existing row this is the stored role, not the requested one, so a
          // demo sign-in can never hand itself more privilege than the account has
          // (review !62 round 12, Critical 1).
          role: effectiveRole,
          iotDbUrl: iotDbUrl,
          userDbUrl: userDbUrl,
          demo: demo,
          sessionId: sessionId != null ? String(sessionId) : undefined,
          demoCleanupToken,
        });

        const token = jwt.sign(
          tokenPayload,
          process.env.JWT_SECRET || 'fallback-secret',
          { expiresIn: '24h' }
        );

        // effectiveRole travels back to the ROUTE, not just into the token
        // (review !62 round 13, Important 3). The login response used to echo the
        // requested role while the JWT carried this one, so a demo sign-in that
        // asked for 'admin' on a viewer account rendered admin-only affordances
        // (Apply) against a token the backend would refuse.
        return { user: user as unknown as User, token, effectiveRole };
      } finally {
        client.release();
      }
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      // Log detailed error information for debugging
      logger.error('Passwordless authentication error:', {
        errorCode: error?.code,
        errorMessage: error?.message,
        errorDetail: error?.detail,
        errorHint: error?.hint,
        errorPosition: error?.position,
        errorStack: error?.stack,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
      });

      // Handle specific PostgreSQL error codes
      const errorCode = error?.code;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // 28P01: Authentication failed (invalid password for settings user)
      // 28000: Invalid authorization specification
      if (errorCode === '28P01' || errorCode === '28000') {
        throw new CustomError(
          `Authentication failed for the dashboard settings database user. The password may have been rotated. Please try again or contact your administrator.`,
          401
        );
      }

      // 3D000: Database does not exist
      if (errorCode === '3D000') {
        throw new CustomError(
          'The specified database does not exist. Please check your connection URL.',
          400
        );
      }

      // ECONNREFUSED: Cannot connect to database
      if (errorCode === 'ECONNREFUSED' || errorMessage.includes('ECONNREFUSED')) {
        throw new CustomError(
          'Cannot connect to the database server. Please check the host and port in your connection URL.',
          400
        );
      }

      // ENOTFOUND: Host not found
      if (errorCode === 'ENOTFOUND' || errorMessage.includes('ENOTFOUND')) {
        throw new CustomError(
          'Database host not found. Please check the hostname in your connection URL.',
          400
        );
      }

      // 42P01: Table does not exist (schema not set up)
      if (errorCode === '42P01') {
        throw new CustomError(
          'Dashboard settings tables are not configured. Please contact your administrator to set up the dashboard_studio_meta_data schema.',
          403
        );
      }

      // 3F000: Schema does not exist
      if (errorCode === '3F000' || errorMessage.includes('schema') && errorMessage.includes('does not exist')) {
        throw new CustomError(
          'Dashboard settings schema (dashboard_studio_meta_data) does not exist in this database. Please contact your administrator.',
          403
        );
      }

      throw new CustomError(
        `Authentication failed: ${errorMessage}`,
        500
      );
    }
  }

  async getUserRole(userId: string, pool: Pool): Promise<string> {
    try {
      const client = await pool.connect();

      try {
        const result = await client.query(
          'SELECT role FROM dashboard_studio_meta_data.user_roles WHERE user_id = $1',
          [userId]
        );

        return result.rows.length > 0 ? result.rows[0].role : 'viewer';
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting user role:', error);
      return 'viewer';
    }
  }

  async getUsers(pool: Pool): Promise<User[]> {
    try {
      const client = await pool.connect();

      try {
        const result = await client.query(
          'SELECT * FROM dashboard_studio_meta_data.users ORDER BY created_at ASC'
        );

        return result.rows as User[];
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting users:', error);
      throw new CustomError('Failed to get users', 500);
    }
  }

  // ==========================================
  // Global Variables Methods
  // ==========================================

  // Default system variables that should always exist
  private static readonly DEFAULT_GLOBAL_VARIABLES = [
    {
      label: 'sql_timeout_ms',
      description: 'SQL query timeout in milliseconds (default: 30000 = 30 seconds)',
      value: '30000'
    }
  ];

  // Global variables change rarely (admin action) but are read on every panel
  // execution and composite-report load. Cache them per tenant for a short
  // window; mutations invalidate the key explicitly, so staleness is bounded by
  // this TTL only across backend instances that didn't perform the write.
  private static readonly GLOBAL_VARS_CACHE_TTL_SECONDS = 60;
  // Delay before the second (race-closing) cache eviction after a mutation —
  // see invalidateGlobalVarsCache. Long enough to outlast a concurrent reader's
  // cache-miss fetch tail, short enough to bound any stale window to this.
  private static readonly GLOBAL_VARS_CACHE_INVALIDATION_DELAY_MS = 500;

  /**
   * Run a settings-DB read, retrying a couple of times with small backoff when
   * the failure is a transient connection error (see {@link isTransientDbError}
   * — the DO-287 symptom). Idempotent reads only — do not wrap writes with this.
   * A non-transient error (bad SQL, missing column, 0 rows) throws immediately.
   */
  private async withSettingsDbRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await op();
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isTransientDbError(error)) throw error;
        const delayMs = attempt * 150;
        logger.warn('Transient settings-DB error; retrying', {
          label, attempt, maxAttempts, delayMs, error: toErrorMeta(error).message,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  /**
   * Per-tenant Redis key for the global-variables cache. Returns null when the
   * pool's tenant identity is unknown (it wasn't created via
   * getClientSettingsPool) — callers then skip the cache entirely rather than
   * risk serving one tenant's variables to another.
   */
  private globalVarsCacheKey(pool: Pool): string | null {
    const tenantKey = this.settingsPoolKeys.get(pool);
    return tenantKey ? `global_vars:${tenantKey}` : null;
  }

  /**
   * Drop the cached global variables for a tenant after a mutation. Best-effort.
   *
   * Evicts immediately and then once more after a short delay (the delayed
   * double-delete pattern). The second eviction removes a stale entry that a
   * reader which had *already* fetched pre-mutation rows could write back
   * *after* the first delete — closing the read-populate vs. invalidate race
   * that would otherwise leave stale variables cached until the TTL expires.
   *
   * Trade-off (intentional): the delayed delete can't distinguish that stale
   * write-back from a *fresh* post-mutation populate, so it may also evict an
   * already-correct entry. The only cost is one extra DB read on the next
   * request (re-populated from up-to-date rows) within the ~500 ms after a rare
   * admin mutation — correctness is never affected, so the cheap blanket second
   * delete is preferred over versioning/locking the cache.
   */
  async invalidateGlobalVarsCache(pool: Pool): Promise<void> {
    const cacheKey = this.globalVarsCacheKey(pool);
    if (!cacheKey) return;
    const redis = RedisService.getInstance();
    try {
      await redis.del(cacheKey);
    } catch (error) {
      logger.warn('Failed to invalidate global variables cache', { error: toErrorMeta(error).message });
    }
    // Second, delayed eviction to catch a racing reader's stale write-back.
    const timer = setTimeout(() => {
      redis.del(cacheKey).catch((error) => {
        logger.warn('Delayed global variables cache eviction failed', { error: toErrorMeta(error).message });
      });
    }, DatabaseService.GLOBAL_VARS_CACHE_INVALIDATION_DELAY_MS);
    // Don't keep the event loop alive solely for this best-effort timer.
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Insert the default global variables (idempotent upserts). Best-effort.
   *
   * Pass `existingClient` to reuse a connection the caller already holds — the
   * cache-miss path in {@link getGlobalVariables} does this so a single read
   * uses one pool connection (not two overlapping ones) and skips the
   * table-existence check it has already performed. Called standalone (no
   * client), it acquires its own connection and verifies the table itself.
   */
  async ensureDefaultGlobalVariables(pool: Pool, existingClient?: PoolClient): Promise<void> {
    let client: PoolClient | null = existingClient ?? null;
    try {
      if (!client) {
        client = await pool.connect();
      }

      // A standalone call must confirm the table exists first; the cache-miss
      // caller already verified it and reuses its client, so skip the redundant
      // check (and the extra round-trip) in that path.
      if (!existingClient) {
        const tableExists = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'dashboard_studio_meta_data'
            AND table_name = 'global_variables'
          )
        `);

        if (!tableExists.rows[0].exists) {
          logger.warn('global_variables table does not exist, cannot ensure defaults');
          return;
        }
      }

      // Insert default variables if they don't exist
      for (const variable of DatabaseService.DEFAULT_GLOBAL_VARIABLES) {
        await client.query(
          `INSERT INTO dashboard_studio_meta_data.global_variables (label, description, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (label) DO NOTHING`,
          [variable.label, variable.description, variable.value]
        );
      }

      logger.info('Ensured default global variables exist');
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      // Don't throw - this is a best-effort operation
      logger.warn('Could not ensure default global variables:', error.message);
    } finally {
      // Only release a connection we acquired here — never the caller's.
      if (!existingClient && client) client.release();
    }
  }

  async getGlobalVariables(pool: Pool): Promise<Record<string, unknown>[]> {
    const cacheKey = this.globalVarsCacheKey(pool);
    const redis = RedisService.getInstance();

    // Best-effort cache read — a miss, an unknown tenant, or any Redis error
    // just falls through to the DB (Redis is optional; the backend runs without
    // it).
    if (cacheKey) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as Record<string, unknown>[];
      } catch (error) {
        logger.warn('Global variables cache read failed; querying DB', { error: toErrorMeta(error).message });
      }
    }

    try {
      const rows = await this.withSettingsDbRetry('getGlobalVariables', async () => {
        const client = await pool.connect();

        try {
          // Check if table exists first (in dashboard_studio_meta_data schema)
          const tableExists = await client.query(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables
              WHERE table_schema = 'dashboard_studio_meta_data'
              AND table_name = 'global_variables'
            )
          `);

          if (!tableExists.rows[0].exists) {
            logger.warn('global_variables table does not exist in dashboard_studio_meta_data schema');
            return [] as Record<string, unknown>[];
          }

          // Ensure default variables exist before fetching. This runs only on a
          // cache miss now (previously every read), so a plain read no longer
          // depends on a write succeeding — important when the settings DB is
          // briefly routed to a read-only standby. Reuse this client so the read
          // uses a single pool connection rather than opening a second one.
          await this.ensureDefaultGlobalVariables(pool, client);

          const result = await client.query(
            'SELECT * FROM dashboard_studio_meta_data.global_variables ORDER BY label ASC'
          );

          logger.info('Loaded global variables', { count: result.rows.length, labels: result.rows.map((r: Record<string, unknown>) => r.label) });
          return result.rows as Record<string, unknown>[];
        } finally {
          client.release();
        }
      });

      // Best-effort cache write (only when the tenant is identifiable).
      if (cacheKey) {
        try {
          await redis.set(cacheKey, JSON.stringify(rows), DatabaseService.GLOBAL_VARS_CACHE_TTL_SECONDS);
        } catch (error) {
          logger.warn('Global variables cache write failed', { error: toErrorMeta(error).message });
        }
      }
      return rows;
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      // If table doesn't exist, return empty array instead of error
      if (error.code === '42P01') { // undefined_table
        logger.warn('global_variables table does not exist:', error.message);
        return [];
      }
      logger.error('Error getting global variables:', error);
      throw new CustomError('Failed to get global variables', 500);
    }
  }

  /**
   * Get the drag-n-drop chart preset catalog (FR-11365).
   * Singleton row in dashboard_studio_meta_data.chart_preset_catalog; the `catalog`
   * jsonb holds { schemaVersion, groups }. Returns null (not an error) when the
   * table/row is missing so the endpoint can serve an empty catalog.
   */
  async getChartPresetCatalog(pool: Pool): Promise<{ schemaVersion: string; groups: unknown[] } | null> {
    try {
      const client = await pool.connect();

      try {
        const tableExists = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'dashboard_studio_meta_data'
            AND table_name = 'chart_preset_catalog'
          )
        `);

        if (!tableExists.rows[0].exists) {
          logger.warn('chart_preset_catalog table does not exist in dashboard_studio_meta_data schema');
          return null;
        }

        const result = await client.query(
          'SELECT schema_version, catalog FROM dashboard_studio_meta_data.chart_preset_catalog ORDER BY id ASC LIMIT 1'
        );

        if (result.rows.length === 0) {
          logger.warn('chart_preset_catalog has no rows');
          return null;
        }

        const row = result.rows[0];
        const catalog = (row.catalog && typeof row.catalog === 'object') ? row.catalog : {};
        const groups = Array.isArray(catalog.groups) ? catalog.groups : [];

        logger.info('Loaded chart preset catalog', { groups: groups.length, schemaVersion: catalog.schemaVersion || row.schema_version });
        return {
          schemaVersion: catalog.schemaVersion || row.schema_version || '1.0',
          groups,
        };
      } finally {
        client.release();
      }
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      // If table doesn't exist, return null instead of error
      if (error.code === '42P01') { // undefined_table
        logger.warn('chart_preset_catalog table does not exist:', error.message);
        return null;
      }
      logger.error('Error getting chart preset catalog:', error);
      throw new CustomError('Failed to get chart preset catalog', 500);
    }
  }

  async getGlobalVariableById(id: string, pool: Pool): Promise<Record<string, unknown> | null> {
    try {
      const client = await pool.connect();

      try {
        const result = await client.query(
          'SELECT * FROM dashboard_studio_meta_data.global_variables WHERE id = $1',
          [id]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting global variable:', error);
      throw new CustomError('Failed to get global variable', 500);
    }
  }

  async createGlobalVariable(data: {
    label: string;
    description?: string;
    value?: string;
  }, pool: Pool): Promise<Record<string, unknown>> {
    try {
      const client = await pool.connect();

      try {
        const result = await client.query(
          `INSERT INTO dashboard_studio_meta_data.global_variables (label, description, value)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [data.label, data.description || null, data.value || null]
        );

        return result.rows[0];
      } finally {
        client.release();
      }
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      if (error.code === '23505') { // Unique violation
        throw new CustomError('A variable with this label already exists', 409);
      }
      logger.error('Error creating global variable:', error);
      throw error instanceof CustomError ? error : new CustomError('Failed to create global variable', 500);
    }
  }

  async updateGlobalVariable(id: string, data: {
    label?: string;
    description?: string;
    value?: string;
  }, pool: Pool): Promise<Record<string, unknown>> {
    try {
      const client = await pool.connect();

      try {
        // Get existing variable
        const existing = await this.getGlobalVariableById(id, pool);
        if (!existing) {
          throw new CustomError('Global variable not found', 404);
        }

        const updateFields: string[] = [];
        const updateValues: unknown[] = [];
        let paramIndex = 1;

        // Allow updating all fields
        if (data.label !== undefined) {
          updateFields.push(`label = $${paramIndex}`);
          updateValues.push(data.label);
          paramIndex++;
        }
        if (data.description !== undefined) {
          updateFields.push(`description = $${paramIndex}`);
          updateValues.push(data.description);
          paramIndex++;
        }
        if (data.value !== undefined) {
          updateFields.push(`value = $${paramIndex}`);
          updateValues.push(data.value);
          paramIndex++;
        }

        if (updateFields.length === 0) {
          return existing;
        }

        updateFields.push(`updated_at = NOW()`);
        updateValues.push(id);

        const result = await client.query(
          `UPDATE dashboard_studio_meta_data.global_variables 
           SET ${updateFields.join(', ')}
           WHERE id = $${paramIndex}
           RETURNING *`,
          updateValues
        );

        if (result.rows.length === 0) {
          throw new CustomError('Global variable not found', 404);
        }

        return result.rows[0];
      } finally {
        client.release();
      }
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      if (error.code === '23505') { // Unique violation
        throw new CustomError('A variable with this label already exists', 409);
      }
      logger.error('Error updating global variable:', error);
      throw error instanceof CustomError ? error : new CustomError('Failed to update global variable', 500);
    }
  }

  async deleteGlobalVariable(id: string, pool: Pool): Promise<void> {
    try {
      const client = await pool.connect();

      try {
        const result = await client.query(
          'DELETE FROM dashboard_studio_meta_data.global_variables WHERE id = $1',
          [id]
        );

        if (result.rowCount === 0) {
          throw new CustomError('Global variable not found', 404);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error deleting global variable:', error);
      throw error instanceof CustomError ? error : new CustomError('Failed to delete global variable', 500);
    }
  }

  async getGlobalVariablesAsMap(pool: Pool): Promise<Record<string, string>> {
    try {
      const variables = await this.getGlobalVariables(pool);
      const map: Record<string, string> = {};

      variables.forEach(variable => {
        if (variable.value !== null && variable.value !== undefined) {
          map[variable.label as string] = variable.value as string;
        }
      });

      return map;
    } catch (error) {
      logger.error('Error getting global variables as map:', error);
      // Return empty map instead of throwing error
      return {};
    }
  }

  /**
   * Load global variables and merge them into `params` as lower-priority
   * defaults: an explicit key in `params` always wins, a global only fills a key
   * that is absent. Returns the merged map plus the raw global variables, which
   * callers also use to resolve the SQL timeout.
   *
   * `getGlobalVariablesAsMap` already degrades to an empty map if the settings
   * DB is unreachable, so this never throws on a global-variable lookup failure.
   */
  async mergeWithGlobalVars(
    params: Record<string, unknown>,
    settingsPool: Pool,
  ): Promise<{ mergedParams: Record<string, unknown>; globalVars: Record<string, string> }> {
    const globalVars = await this.getGlobalVariablesAsMap(settingsPool);
    const mergedParams: Record<string, unknown> = { ...params };
    for (const [key, value] of Object.entries(globalVars)) {
      if (!(key in mergedParams)) {
        mergedParams[key] = value;
      }
    }
    return { mergedParams, globalVars };
  }

  // ==========================================
  // External Database Methods (for SQL queries)
  // ==========================================

  /**
   * Get user's IoT database URL from raw_user_meta_data
   */
  async getUserIotDbUrl(userId: string, pool: Pool): Promise<string | null> {
    try {
      const client = await pool.connect();

      try {
        const result = await client.query(
          'SELECT raw_user_meta_data FROM dashboard_studio_meta_data.users WHERE id = $1',
          [userId]
        );

        if (result.rows.length === 0) {
          logger.warn('User not found when fetching iotDbUrl', { userId });
          return null;
        }

        const rawMetaData = result.rows[0].raw_user_meta_data;

        if (!rawMetaData) {
          logger.warn('User has no raw_user_meta_data', { userId });
          return null;
        }

        // Parse if it's a string, otherwise use as-is (PostgreSQL JSONB)
        const metaData = typeof rawMetaData === 'string'
          ? JSON.parse(rawMetaData)
          : rawMetaData;

        if (!metaData.iotDbUrl) {
          logger.warn('User raw_user_meta_data has no iotDbUrl', { userId });
          return null;
        }

        return metaData.iotDbUrl;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error fetching user iotDbUrl:', { error, userId });
      throw new CustomError('Failed to get user database configuration', 500);
    }
  }

  /**
   * Test database connection with provided settings
   */
  async testDatabaseConnection(settings: {
    external_db_url?: string;
    external_db_host?: string;
    external_db_port?: string | number;
    external_db_name?: string;
    external_db_user?: string;
    external_db_password?: string;
    external_db_ssl?: boolean;
  }): Promise<void> {
    try {
      let config: DatabaseConfig;

      if (settings.external_db_url) {
        config = this.parsePostgresUrl(settings.external_db_url);
      } else if (settings.external_db_host && settings.external_db_name && settings.external_db_user) {
        config = {
          user: settings.external_db_user,
          password: settings.external_db_password || '',
          database: settings.external_db_name,
          hostname: settings.external_db_host,
          port: Number(settings.external_db_port) || 5432,
          ssl: settings.external_db_ssl || false,
        };
      } else {
        throw new CustomError('Incomplete database configuration provided for testing', 400);
      }

      // Create a temporary pool for testing
      const poolConfig = {
        user: config.user,
        password: config.password,
        database: config.database,
        host: config.hostname,
        port: config.port,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
        max: 1,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 10000,
      };

      logger.info('Creating test pool with config', {
        host: poolConfig.host,
        port: poolConfig.port,
        database: poolConfig.database,
        user: poolConfig.user,
        connectionTimeout: poolConfig.connectionTimeoutMillis
      });

      const testPool = new Pool(poolConfig);

      let client: PoolClient | null = null;
      try {
        logger.info('Attempting to connect to database...');
        const connectStartTime = Date.now();
        client = await testPool.connect();
        const connectTime = Date.now() - connectStartTime;
        logger.info('Successfully obtained client from pool', { connectTimeMs: connectTime });

        logger.info('Executing test query...');
        const queryStartTime = Date.now();
        const result = await client.query('SELECT 1 as test');
        const queryTime = Date.now() - queryStartTime;
        logger.info('Test query executed successfully', {
          queryTimeMs: queryTime,
          result: result.rows[0]
        });

        logger.info('Database connection test successful', {
          host: config.hostname,
          port: config.port,
          database: config.database,
          user: config.user,
          totalTimeMs: Date.now() - connectStartTime
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorCode = toErrorMeta(error).code;

        logger.error('Database connection test failed - detailed error:', {
          host: config.hostname,
          port: config.port,
          database: config.database,
          user: config.user,
          errorMessage,
          errorCode,
        });

        // Provide more helpful error messages
        let userFriendlyMessage = errorMessage;
        if (errorMessage.includes('ECONNREFUSED') || errorCode === 'ECONNREFUSED') {
          userFriendlyMessage = `Cannot connect to database at ${config.hostname}:${config.port}. Please ensure PostgreSQL is running and accessible from the backend server.`;
        } else if (errorMessage.includes('authentication failed') || errorMessage.includes('password') || errorCode === '28P01') {
          userFriendlyMessage = `Authentication failed. Please check your username and password.`;
        } else if (errorMessage.includes('does not exist') || errorCode === '3D000') {
          userFriendlyMessage = `Database "${config.database}" does not exist. Please check the database name.`;
        }

        throw new CustomError(`Failed to connect to database: ${userFriendlyMessage}`, 400);
      } finally {
        if (client) {
          client.release();
        }
        await testPool.end();
      }
    } catch (error) {
      if (error instanceof CustomError) {
        throw error;
      }
      logger.error('Unexpected error testing database connection:', error);
      throw new CustomError(
        `Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        400
      );
    }
  }

  private async getExternalDatabaseConfig(iotDbUrl: string): Promise<DatabaseConfig> {
    return this.parsePostgresUrl(iotDbUrl);
  }

  private async getExternalPool(config: DatabaseConfig): Promise<Pool> {
    const configKey = `${config.user}@${config.hostname}:${config.port}/${config.database}`;

    const existing = this.externalPools.get(configKey);
    if (existing && existing.password !== config.password) {
      logger.info('Password changed for external pool, recreating', { configKey });
      existing.pool.end().catch(err => {
        logger.error('Error closing stale external pool', { configKey, error: err.message });
      });
      this.externalPools.delete(configKey);
    }

    if (!this.externalPools.has(configKey)) {
      const pool = new Pool({
        user: config.user,
        password: config.password,
        database: config.database,
        host: config.hostname,
        port: config.port,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });

      pool.on('error', (err) => {
        logger.error('Unexpected error on idle external pool client', { configKey, error: err.message });
      });

      this.wrapPool(pool, configKey);
      this.externalPools.set(configKey, { pool, password: config.password });
    }

    return this.externalPools.get(configKey)!.pool;
  }

  // ==========================================
  // Query Execution Methods
  // ==========================================

  private getPostgresTypeName(oid: number): string {
    const typeMap: Record<number, string> = {
      16: 'boolean',
      20: 'bigint',
      21: 'smallint',
      23: 'integer',
      25: 'text',
      700: 'real',
      701: 'double precision',
      1043: 'varchar',
      1082: 'date',
      1114: 'timestamp',
      1184: 'timestamptz',
      1700: 'numeric',
      2950: 'uuid',
    };
    return typeMap[oid] || `type(${oid})`;
  }

  async executeTableQuery(
    sql: string,
    page: number = 1,
    pageSize: number = 25,
    sort?: string,
    iotDbUrl?: string,
    timeoutMs: number = 30000,
  ): Promise<QueryResult> {
    // Validate SQL using the new SQLSelectGuard
    try {
      SQLSelectGuard.assertSafeSelect(sql);
    } catch (error) {
      if (error instanceof Error) {
        throw new CustomError(error.message, 400);
      }
      throw new CustomError('SQL validation failed', 400);
    }

    if (!iotDbUrl) {
      throw new CustomError('iotDbUrl is required for query execution', 400);
    }

    const config = await this.getExternalDatabaseConfig(iotDbUrl);
    const pool = await this.getExternalPool(config);
    let client: PoolClient | null = null;

    try {
      client = await pool.connect();

      // Timeout + explicit RESET TIME ZONE: this endpoint never takes a zone,
      // and must not inherit one left on the pooled connection by
      // executeParameterizedQuery.
      await this.initSessionState(client, timeoutMs);

      // Extract LIMIT from user's query if present
      const limitMatch = sql.trim().match(/\s+LIMIT\s+(\d+)(?:\s+OFFSET\s+\d+)?(?:\s*;)?$/i);
      const userLimit = limitMatch && limitMatch[1] ? parseInt(limitMatch[1]) : null;

      // Strip any existing LIMIT/OFFSET from the user's query
      const cleanedSql = sql.trim().replace(/;$/, '').replace(/\s+LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?$/i, '');

      // Get total count
      const countSql = `SELECT COUNT(*) as total FROM (${cleanedSql}) as count_query`;
      const countResult = await client.query(countSql);
      const total = countResult.rows && countResult.rows.length > 0
        ? parseInt(countResult.rows[0].total)
        : 0;

      // Use user's LIMIT if it's smaller than pageSize, otherwise use pageSize
      const effectiveLimit = userLimit !== null && userLimit < pageSize ? userLimit : pageSize;

      // Apply pagination
      const offset = (page - 1) * effectiveLimit;
      const paginatedSql = `${cleanedSql} LIMIT ${effectiveLimit} OFFSET ${offset}`;

      const result = await client.query(paginatedSql);

      // Extract columns and rows
      const columns = result.rows && result.rows.length > 0 ? Object.keys(result.rows[0]) : [];

      // Convert BigInt values to strings for JSON serialization
      const rows = (result.rows || []).map((row: Record<string, unknown>) => {
        const convertedRow: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          convertedRow[key] = typeof value === 'bigint' ? value.toString() : value;
        }
        return convertedRow;
      });

      // Get column types from the result metadata
      const columnTypes: Record<string, string> = {};
      if (result.fields) {
        result.fields.forEach((field: FieldDef) => {
          const typeName = field.dataTypeID ? this.getPostgresTypeName(field.dataTypeID) : 'unknown';
          columnTypes[field.name] = typeName;
        });
      }

      logger.info('Table query executed successfully', {
        sql: sql.substring(0, 100) + '...',
        totalRows: total,
        returnedRows: rows.length,
        page,
        pageSize: effectiveLimit,
      });

      return {
        columns,
        rows,
        columnTypes,
        total,
        page,
        pageSize: effectiveLimit,
      };
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      logger.error('Database query error:', {
        error: error.message,
        sql: sql.substring(0, 100) + '...',
        code: error.code,
        position: error.position,
      });

      // Build detailed error message for user
      let userMessage = error.message || 'Database error';
      if (error.code) {
        userMessage = `[${error.code}] ${userMessage}`;
      }
      if (error.position) {
        userMessage += ` at position ${error.position}`;
      }

      throw new CustomError(userMessage, 400);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  async executeTileQuery(sql: string, iotDbUrl?: string, timeoutMs: number = 30000): Promise<TileResult> {
    // Validate SQL using the new SQLSelectGuard
    try {
      SQLSelectGuard.assertSafeSelect(sql);
    } catch (error) {
      if (error instanceof Error) {
        throw new CustomError(error.message, 400);
      }
      throw new CustomError('SQL validation failed', 400);
    }

    if (!iotDbUrl) {
      throw new CustomError('iotDbUrl is required for query execution', 400);
    }

    const config = await this.getExternalDatabaseConfig(iotDbUrl);
    const pool = await this.getExternalPool(config);
    let client: PoolClient | null = null;

    try {
      client = await pool.connect();

      // Timeout + explicit RESET TIME ZONE — see executeTableQuery.
      await this.initSessionState(client, timeoutMs);

      // Execute query with LIMIT 1 enforced
      const safeSql = sql.trim().replace(/;$/, '') + ' LIMIT 1';
      const result = await client.query(safeSql);

      // Extract first value
      let value: number | null = null;
      if (result.rows && result.rows.length > 0) {
        const firstRow = result.rows[0];
        const firstValue = Object.values(firstRow)[0];

        // Handle BigInt conversion
        if (typeof firstValue === 'bigint') {
          value = Number(firstValue);
        } else if (typeof firstValue === 'number') {
          value = firstValue;
        } else if (typeof firstValue === 'string' && !isNaN(parseFloat(firstValue))) {
          value = parseFloat(firstValue);
        } else if (firstValue === null) {
          value = null;
        }
      }

      logger.info('Tile query executed successfully', {
        sql: sql.substring(0, 100) + '...',
        value,
      });

      return { value };
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      logger.error('Database tile query error:', {
        error: error.message,
        sql: sql.substring(0, 100) + '...',
        code: error.code,
        position: error.position,
      });

      // Build detailed error message for user
      let userMessage = error.message || 'Database error';
      if (error.code) {
        userMessage = `[${error.code}] ${userMessage}`;
      }
      if (error.position) {
        userMessage += ` at position ${error.position}`;
      }

      throw new CustomError(userMessage, 400);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // ==========================================
  // App Data Methods (Reports, Sections, etc.)
  // ==========================================

  async getSections(pool: Pool, userId?: string): Promise<Record<string, unknown>[]> {
    try {
      const client = await pool.connect();

      try {
        if (userId) {
          // Filter by user_id
          const result = await client.query(
            'SELECT * FROM dashboard_studio_meta_data.sections WHERE user_id = $1 AND is_deleted = FALSE ORDER BY sort_order',
            [userId]
          );
          return result.rows;
        } else {
          // First check if the function exists, if not use simple query
          const functionCheck = await client.query(
            `SELECT EXISTS (
              SELECT 1 FROM pg_proc p 
              JOIN pg_namespace n ON p.pronamespace = n.oid 
              WHERE n.nspname = 'dashboard_studio_meta_data' AND p.proname = 'get_section_hierarchy'
            )`
          );

          if (functionCheck.rows[0].exists) {
            const result = await client.query(`SELECT * FROM dashboard_studio_meta_data.get_section_hierarchy()`);
            return result.rows;
          } else {
            // Fallback to simple query
            const result = await client.query(
              'SELECT * FROM dashboard_studio_meta_data.sections WHERE is_deleted = FALSE ORDER BY sort_order'
            );
            return result.rows;
          }
        }
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting sections:', error);
      throw new CustomError('Failed to get sections', 500);
    }
  }

  async getReports(pool: Pool, userId?: string): Promise<Record<string, unknown>[]> {
    try {
      const client = await pool.connect();

      try {
        let result;
        if (userId) {
          // Filter by user_id
          result = await client.query(`
            SELECT r.*, s.name as section_name 
            FROM dashboard_studio_meta_data.reports r 
            LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id 
            WHERE r.user_id = $1 AND r.is_deleted = FALSE
            ORDER BY s.sort_order, r.sort_order
          `, [userId]);
        } else {
          result = await client.query(`
            SELECT r.*, s.name as section_name 
            FROM dashboard_studio_meta_data.reports r 
            LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id 
            WHERE r.is_deleted = FALSE
            ORDER BY s.sort_order, r.sort_order
          `);
        }

        // Parse report_schema JSONB fields for all reports
        const reports = result.rows.map(report => {
          if (report.report_schema && typeof report.report_schema === 'string') {
            try {
              report.report_schema = JSON.parse(report.report_schema);
            } catch (parseError) {
              logger.warn('Failed to parse report_schema JSON:', parseError);
              // Keep as string if parsing fails
            }
          }
          return report;
        });

        return reports;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting reports:', error);
      throw new CustomError('Failed to get reports', 500);
    }
  }

  async getReportById(id: string, pool: Pool, userId?: string): Promise<Record<string, unknown> | null> {
    try {
      const client = await pool.connect();

      try {
        let result;
        if (userId) {
          // Filter by user_id for security
          result = await client.query(
            `SELECT r.*, s.name as section_name 
             FROM dashboard_studio_meta_data.reports r 
             LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id 
             WHERE r.id = $1 AND r.user_id = $2 AND r.is_deleted = FALSE`,
            [id, userId]
          );
        } else {
          result = await client.query(
            `SELECT r.*, s.name as section_name 
             FROM dashboard_studio_meta_data.reports r 
             LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id 
             WHERE r.id = $1 AND r.is_deleted = FALSE`,
            [id]
          );
        }

        if (result.rows.length === 0) {
          return null;
        }

        const report = result.rows[0];

        // Parse the report_schema JSONB field if it exists
        if (report.report_schema && typeof report.report_schema === 'string') {
          try {
            report.report_schema = JSON.parse(report.report_schema);
          } catch (parseError) {
            logger.warn('Failed to parse report_schema JSON:', parseError);
            // Keep as string if parsing fails
          }
        }

        return report;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error getting report:', error);
      throw new CustomError('Failed to get report', 500);
    }
  }

  // ==========================================
  // Composite Reports Methods
  // ==========================================
  // Composite reports are stored in the existing 'reports' table
  // They are identified by report_schema->>'type' = 'composite'
  // The report_schema contains: type, description, sqlQuery, config

  /**
   * Transform a report row from the database into a composite report format
   */
  private transformToCompositeReport(report: Record<string, unknown>): Record<string, unknown> {
    // Parse report_schema if it's a string
    let schemaRaw = report.report_schema;
    if (schemaRaw && typeof schemaRaw === 'string') {
      try {
        schemaRaw = JSON.parse(schemaRaw);
      } catch (parseError) {
        logger.warn('Failed to parse report_schema JSON:', parseError);
        schemaRaw = {};
      }
    }
    const schema = (schemaRaw || {}) as Record<string, unknown>;

    return {
      id: report.id,
      title: report.title,
      description: schema.description || null,
      slug: report.slug,
      section_id: report.section_id,
      section_name: report.section_name,
      sort_order: report.sort_order,
      sql_query: schema.sqlQuery || '',
      config: schema.config || {
        table: { enabled: true, pageSize: 50, maxRows: 10000 },
        chart: { enabled: true, type: 'timeseries' },
        map: { enabled: false, autoDetect: true }
      },
      report_schema: schema,
      user_id: report.user_id,
      created_by: report.created_by,
      updated_by: report.updated_by,
      created_at: report.created_at,
      updated_at: report.updated_at,
      is_deleted: report.is_deleted,
    };
  }

  async getCompositeReports(pool: Pool, userId?: string): Promise<Record<string, unknown>[]> {
    try {
      const client = await pool.connect();

      try {
        let result;
        if (userId) {
          result = await client.query(`
            SELECT r.*, s.name as section_name 
            FROM dashboard_studio_meta_data.reports r 
            LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id 
            WHERE r.user_id = $1 AND r.is_deleted = FALSE
              AND r.report_schema->>'type' = 'composite'
            ORDER BY s.sort_order, r.sort_order
          `, [userId]);
        } else {
          result = await client.query(`
            SELECT r.*, s.name as section_name 
            FROM dashboard_studio_meta_data.reports r 
            LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id 
            WHERE r.is_deleted = FALSE
              AND r.report_schema->>'type' = 'composite'
            ORDER BY s.sort_order, r.sort_order
          `);
        }

        return result.rows.map(report => this.transformToCompositeReport(report));
      } finally {
        client.release();
      }
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      logger.error('Error getting composite reports:', error);
      throw new CustomError('Failed to get composite reports', 500);
    }
  }

  async getCompositeReportById(id: string, pool: Pool, userId?: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.withSettingsDbRetry('getCompositeReportById', async () => {
        const client = await pool.connect();

        try {
          let result;
          if (userId) {
            result = await client.query(
              `SELECT r.*, s.name as section_name
               FROM dashboard_studio_meta_data.reports r
               LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id
               WHERE r.id = $1 AND r.user_id = $2 AND r.is_deleted = FALSE
                 AND r.report_schema->>'type' = 'composite'`,
              [id, userId]
            );
          } else {
            result = await client.query(
              `SELECT r.*, s.name as section_name
               FROM dashboard_studio_meta_data.reports r
               LEFT JOIN dashboard_studio_meta_data.sections s ON r.section_id = s.id
               WHERE r.id = $1 AND r.is_deleted = FALSE
                 AND r.report_schema->>'type' = 'composite'`,
              [id]
            );
          }

          if (result.rows.length === 0) {
            return null;
          }

          return this.transformToCompositeReport(result.rows[0]);
        } finally {
          client.release();
        }
      });
    } catch (error) {
      logger.error('Error getting composite report:', error);
      throw new CustomError('Failed to get composite report', 500);
    }
  }

  async createCompositeReport(data: {
    title: string;
    description?: string;
    slug: string;
    section_id?: string;
    sort_order?: number;
    sql_query: string;
    config: Record<string, unknown>;
    report_schema?: Record<string, unknown>;
    user_id: string;
    created_by: string;
  }, pool: Pool): Promise<Record<string, unknown>> {
    try {
      const client = await pool.connect();

      try {
        // Build the report_schema with composite report data
        const compositeSchema = {
          type: 'composite',
          description: data.description || null,
          sqlQuery: data.sql_query,
          config: data.config,
          ...(data.report_schema || {})
        };

        const result = await client.query(
          `INSERT INTO dashboard_studio_meta_data.reports 
           (title, slug, section_id, sort_order, report_schema, user_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            data.title,
            data.slug,
            data.section_id || null,
            data.sort_order || 0,
            JSON.stringify(compositeSchema),
            data.user_id,
            data.created_by,
            data.created_by
          ]
        );

        return this.transformToCompositeReport(result.rows[0]);
      } finally {
        client.release();
      }
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      if (error.code === '23505') { // Unique violation
        throw new CustomError('A composite report with this slug already exists', 409);
      }
      logger.error('Error creating composite report:', error);
      throw error instanceof CustomError ? error : new CustomError('Failed to create composite report', 500);
    }
  }

  async updateCompositeReport(id: string, data: {
    title?: string;
    description?: string;
    slug?: string;
    section_id?: string | null;
    sort_order?: number;
    sql_query?: string;
    config?: Record<string, unknown>;
    report_schema?: Record<string, unknown>;
    updated_by: string;
  }, pool: Pool, userId?: string): Promise<Record<string, unknown>> {
    try {
      const client = await pool.connect();

      try {
        // Verify report exists and user has access
        const existing = await this.getCompositeReportById(id, pool, userId);
        if (!existing) {
          throw new CustomError('Composite report not found', 404);
        }

        // Build the updated report_schema
        const existingSchema = (existing.report_schema || {}) as Record<string, unknown>;
        const updatedSchema = {
          ...existingSchema,
          type: 'composite',
          description: data.description !== undefined ? data.description : existingSchema.description,
          sqlQuery: data.sql_query !== undefined ? data.sql_query : existingSchema.sqlQuery,
          config: data.config !== undefined ? data.config : existingSchema.config,
          ...(data.report_schema || {})
        };

        const updateFields: string[] = [];
        const updateValues: unknown[] = [];
        let paramIndex = 1;

        if (data.title !== undefined) {
          updateFields.push(`title = $${paramIndex}`);
          updateValues.push(data.title);
          paramIndex++;
        }
        if (data.slug !== undefined) {
          updateFields.push(`slug = $${paramIndex}`);
          updateValues.push(data.slug);
          paramIndex++;
        }
        if (data.section_id !== undefined) {
          updateFields.push(`section_id = $${paramIndex}`);
          updateValues.push(data.section_id);
          paramIndex++;
        }
        if (data.sort_order !== undefined) {
          updateFields.push(`sort_order = $${paramIndex}`);
          updateValues.push(data.sort_order);
          paramIndex++;
        }

        // Always update report_schema with the merged data
        updateFields.push(`report_schema = $${paramIndex}`);
        updateValues.push(JSON.stringify(updatedSchema));
        paramIndex++;

        updateFields.push(`updated_by = $${paramIndex}`);
        updateValues.push(data.updated_by);
        paramIndex++;

        updateFields.push(`updated_at = NOW()`);

        updateValues.push(id);

        const result = await client.query(
          `UPDATE dashboard_studio_meta_data.reports 
           SET ${updateFields.join(', ')}
           WHERE id = $${paramIndex}
           RETURNING *`,
          updateValues
        );

        if (result.rows.length === 0) {
          throw new CustomError('Composite report not found', 404);
        }

        return this.transformToCompositeReport(result.rows[0]);
      } finally {
        client.release();
      }
    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      if (error.code === '23505') { // Unique violation
        throw new CustomError('A composite report with this slug already exists', 409);
      }
      logger.error('Error updating composite report:', error);
      throw error instanceof CustomError ? error : new CustomError('Failed to update composite report', 500);
    }
  }

  async deleteCompositeReport(id: string, pool: Pool, userId?: string): Promise<void> {
    try {
      const client = await pool.connect();

      try {
        // Verify report exists and user has access
        const existing = await this.getCompositeReportById(id, pool, userId);
        if (!existing) {
          throw new CustomError('Composite report not found', 404);
        }

        // Soft delete
        const result = await client.query(
          `UPDATE dashboard_studio_meta_data.reports 
           SET is_deleted = TRUE, updated_at = NOW()
           WHERE id = $1`,
          [id]
        );

        if (result.rowCount === 0) {
          throw new CustomError('Composite report not found', 404);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Error deleting composite report:', error);
      throw error instanceof CustomError ? error : new CustomError('Failed to delete composite report', 500);
    }
  }

  async closeAllConnections(): Promise<void> {
    // Close all client settings pools
    for (const [key, { pool }] of this.clientSettingsPools) {
      await pool.end();
      logger.info(`Closed client settings pool: ${key}`);
    }
    this.clientSettingsPools.clear();

    // Close all external pools
    for (const [key, { pool }] of this.externalPools) {
      await pool.end();
      logger.info(`Closed external database pool: ${key}`);
    }
    this.externalPools.clear();
  }

  /**
   * Execute parameterized SQL query with typed parameters
   * @param iotDbUrl - User's IoT database URL for query execution
   * @param settingsPool - Pool for fetching user settings (optional, for global variables)
   */
  /**
   * Put a freshly checked-out client into a known session state before the
   * user's query runs. External pools are shared per iotDbUrl, so a client can
   * carry whatever the previous renter set — every execution must therefore
   * state its own timezone explicitly: set it when the request resolved one,
   * RESET back to the server default when it did not. Without the RESET, a
   * legacy /table or /tile call after a zoned dashboard query would silently
   * run in that viewer's zone.
   *
   * The zone is applied with a bound set_config() rather than SET because SET
   * cannot take bind parameters, and the value originates in the request body.
   * The timeout is clamped to a positive integer for the same reason — it is
   * interpolated into the SET text, and `limits.timeout_ms` is client-typed
   * only, so anything non-numeric must never reach the statement.
   *
   * A zone Intl accepted can still be missing from the server's tzdata (they
   * ship separately). That failure degrades to the session default — the same
   * rendering the panel showed before zones were passed at all — instead of
   * failing a query that would otherwise succeed.
   */
  private async initSessionState(
    client: PoolClient,
    timeoutMs: number,
    timeZone?: string,
  ): Promise<void> {
    // Floor before the range check: a fractional value in (0, 1) would pass a
    // raw `> 0` guard and floor to 0 afterwards — and statement_timeout = 0
    // means "no timeout" to Postgres, not "immediately". The upper bound is
    // the int4 GUC maximum; larger values would fail the SET outright.
    const floored = Math.floor(Number(timeoutMs));
    const timeout = Number.isFinite(floored) && floored > 0
      ? Math.min(floored, 2147483647)
      : 30000;
    // Re-validate at the choke point, whatever route supplied the zone: the
    // sql-new route sanitizes early (its cache key must carry the sanitized
    // zone), but export routes resolve theirs from request bodies and stored
    // preferences — no caller may put an unvetted string into the session
    // GUC. A value that fails — e.g. a bare "+05:00" offset, which Postgres
    // would read with the POSIX inverted sign — degrades to the server
    // default exactly like an absent zone (DO-352 review).
    const sessionZone = sanitizeTimeZone(timeZone);
    if (timeZone && !sessionZone) {
      logger.warn('Session timezone failed validation; using the server default', { timeZone });
    }
    if (sessionZone) {
      try {
        await client.query(
          "SELECT set_config('statement_timeout', $1, false), set_config('TimeZone', $2, false)",
          [String(timeout), sessionZone],
        );
        return;
      } catch (rawError: unknown) {
        const meta = toErrorMeta(rawError);
        if (meta.code === '22023') {
          // invalid_parameter_value: the zone passed Intl but is missing from
          // the server's tzdata. Degrading to the server default is the point.
          logger.warn('Session timezone rejected by the database; using the server default', {
            timeZone: sessionZone,
            error: meta.message,
          });
        } else {
          // Not a zone problem (dead connection, network...). Still fall
          // through: the SET below will surface the real error to the caller
          // instead of this log blaming the timezone.
          logger.warn('Session state init failed; retrying with the server default', {
            timeZone: sessionZone,
            code: meta.code,
            error: meta.message,
          });
        }
      }
    }
    await client.query(`SET statement_timeout = ${timeout}; RESET TIME ZONE`);
  }

  async executeParameterizedQuery(
    statement: string,
    params: Record<string, unknown>,
    timeoutMs: number = 30000,
    maxRows: number = 10000,
    iotDbUrl?: string,
    pagination?: { page: number; pageSize: number },
    timeZone?: string
  ): Promise<ParameterizedQueryResult> {
    const startTime = Date.now();

    // Validate SQL template (with ${variable_name} placeholders) - less strict
    try {
      SQLSelectGuard.assertSafeTemplate(statement);
    } catch (error) {
      if (error instanceof Error) {
        throw new CustomError(`SQL template validation failed: ${error.message}`, 400);
      }
      throw new CustomError('SQL template validation failed', 400);
    }

    if (!iotDbUrl) {
      throw new CustomError('iotDbUrl is required for query execution', 400);
    }

    const config = await this.getExternalDatabaseConfig(iotDbUrl);
    const pool = await this.getExternalPool(config);
    let client: PoolClient | null = null;

    try {
      client = await pool.connect();

      // Statement timeout + session timezone (viewer's zone, or server default)
      await this.initSessionState(client, timeoutMs, timeZone);

      // Check if there are any parameters to process
      const hasParameters = Object.keys(params).length > 0;

      let processedStatement = statement;
      const paramValues: unknown[] = [];
      let usedParamCount = 0;

      if (hasParameters) {
        // Convert parameters to PostgreSQL format
        // Only include parameters that are actually used in the SQL
        // Uses ${variable_name} syntax (Grafana-style template variables)
        Object.entries(params).forEach(([name, value]) => {
          // Check if this parameter is used in the SQL
          // Escape special regex characters in paramName
          const escapedParamName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const paramPattern = new RegExp(`\\$\\{${escapedParamName}\\}`, 'g');
          if (paramPattern.test(processedStatement)) {
            usedParamCount++;
            const placeholder = `$${usedParamCount}`;
            processedStatement = processedStatement.replace(
              paramPattern,
              placeholder
            );
            paramValues.push(value);
          }
        });
      }

      // Validate SQL again after parameter binding to ensure final SQL is safe
      try {
        SQLSelectGuard.assertSafeSelect(processedStatement);
      } catch (error) {
        if (error instanceof Error) {
          throw new CustomError(`SQL validation failed after parameter binding: ${error.message}`, 400);
        }
        throw new CustomError('SQL validation failed after parameter binding', 400);
      }

      let total = 0;
      let finalStatement = processedStatement;
      const finalParamValues = paramValues;
      let effectivePageSize = pagination?.pageSize;

      // Handle pagination if requested
      if (pagination) {
        const { page, pageSize } = pagination;

        // Validate pagination parameters
        if (page < 1 || pageSize < 1 || pageSize > 10000) {
          throw new CustomError('Invalid pagination parameters. Page must be >= 1 and pageSize must be between 1 and 10000', 400);
        }

        // Extract user's LIMIT before stripping so it can be respected
        const limitMatch = processedStatement.trim().match(/\s+LIMIT\s+(\d+)(?:\s+OFFSET\s+\d+)?(?:\s*;)?$/i);
        const userLimit = limitMatch && limitMatch[1] ? parseInt(limitMatch[1], 10) : null;

        // Strip any existing LIMIT/OFFSET from the query
        const cleanedStatement = processedStatement.trim().replace(/;$/, '').replace(/\s+LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?$/i, '');

        // Get total count (wrap query in COUNT)
        const countStatement = `SELECT COUNT(*) as total FROM (${cleanedStatement}) as count_query`;
        const countResult = usedParamCount > 0
          ? await client.query(countStatement, paramValues)
          : await client.query(countStatement);

        total = countResult.rows && countResult.rows.length > 0
          ? parseInt(countResult.rows[0].total as string, 10)
          : 0;

        // If user specified LIMIT, cap the total to respect it
        if (userLimit !== null) {
          total = Math.min(total, userLimit);
        }

        // Use user's LIMIT if it's smaller than pageSize, otherwise use pageSize
        effectivePageSize = userLimit !== null && userLimit < pageSize ? userLimit : pageSize;
        const offset = (page - 1) * effectivePageSize;
        finalStatement = `${cleanedStatement} LIMIT ${effectivePageSize} OFFSET ${offset}`;
      } else {
        // No pagination - check for existing LIMIT clause
        const hasLimitClause = /\bLIMIT\s+\d+/i.test(processedStatement);
        if (!hasLimitClause) {
          // Apply maxRows limit if no LIMIT exists
          finalStatement = `${processedStatement.trim().replace(/;$/, '')} LIMIT ${maxRows}`;
        }
      }

      // Execute query with rowMode: 'array' to preserve column order and handle duplicate column names
      const result = usedParamCount > 0
        ? await client.query({ text: finalStatement, values: finalParamValues, rowMode: 'array' })
        : await client.query({ text: finalStatement, rowMode: 'array' });

      // Convert result to standardized format
      const columns = result.fields.map(field => ({
        name: field.name,
        type: this.getPostgresTypeName(field.dataTypeID)
      }));

      // Transform rows (already arrays thanks to rowMode: 'array')
      const rows = (result.rows as unknown[][]).map(row => {
        return row.map((value) => {
          if (typeof value === 'bigint') {
            return value.toString();
          }
          return value;
        });
      });

      // Enforce max rows limit only if not using pagination
      if (!pagination) {
        const hasLimitClause = /\bLIMIT\s+\d+/i.test(statement);
        if (!hasLimitClause && rows.length > maxRows) {
          throw new CustomError(
            `Query returned too many rows: ${rows.length} > ${maxRows}`,
            400
          );
        }
      }

      const elapsedMs = Date.now() - startTime;

      const resultData: ParameterizedQueryResult = {
        columns,
        rows,
        stats: {
          rowCount: rows.length,
          elapsedMs,
          usedParamCount
        }
      };

      // Add pagination metadata if pagination was requested
      if (pagination) {
        resultData.pagination = {
          page: pagination.page,
          pageSize: effectivePageSize ?? pagination.pageSize,
          total
        };
      }

      return resultData;

    } catch (rawError: unknown) {
      const error = toErrorMeta(rawError);
      logger.error('Parameterized query error:', {
        error: error.message,
        statement: statement.substring(0, 100) + '...',
        paramCount: Object.keys(params).length,
      });

      if (error instanceof CustomError) {
        throw error;
      }

      throw new CustomError(
        error.message || 'Query execution failed',
        error.code === 'ECONNREFUSED' ? 503 : 500
      );
    } finally {
      if (client) {
        client.release();
      }
    }
  }
}

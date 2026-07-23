/**
 * Canonical identity of a settings-DB connection (DO-313, MR !61 round 3).
 *
 * ONE normalization, TWO consumers: DatabaseService keys its settings-pool cache
 * with settingsPoolKey(), and the agent chat store derives its tenant key (the
 * rate-limit bucket and the in-memory transcript scope) from the SAME string via
 * settingsPoolKeyForUrl(). Living in a leaf module makes the two structurally
 * unable to drift — and keeps pg/ioredis/node-sql-parser out of the chat store's
 * import graph (its jest suites run against stub pools, not a database).
 *
 * The identity is user@host:port/database. parsePostgresUrl drops every query
 * parameter except sslmode — and sslmode only selects the transport, not WHICH
 * database is reached — so two URLs that differ only in ignored parameters, or
 * only in password, denote the same physical database and MUST map to one
 * identity. Anything finer hands out state per SPELLING: ?application_name=1,
 * =2, … was a working per-login rate-limit-bucket mint, and password rotation
 * silently orphaned the in-memory fallback transcript (note 56573).
 */
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { CustomError } from '../middleware/errorHandler.js';

export interface DatabaseConfig {
  user: string;
  password: string;
  database: string;
  hostname: string;
  port: number;
  ssl?: boolean;
}

/**
 * Parse a PostgreSQL URL and extract connection components.
 * Moved verbatim from DatabaseService (which still exposes it as a method).
 */
export function parsePostgresUrl(url: string): DatabaseConfig {
  try {
    // Handle postgresql:// URLs
    if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
      throw new Error('Database URL must start with postgresql:// or postgres://');
    }

    const urlObj = new URL(url);
    const sslmode = urlObj.searchParams.get('sslmode');

    const rawUser = urlObj.username || '';
    const rawPassword = urlObj.password || '';
    const decodedUser = decodeURIComponent(rawUser);
    const decodedPassword = decodeURIComponent(rawPassword);

    logger.info('parsePostgresUrl: parsed components', {
      rawUser,
      decodedUser,
      rawPasswordLength: rawPassword.length,
      decodedPasswordLength: decodedPassword.length,
      passwordFirst3: decodedPassword.substring(0, 3),
      passwordLast3: decodedPassword.substring(decodedPassword.length - 3),
      hostname: urlObj.hostname,
      port: urlObj.port,
      pathname: urlObj.pathname,
      sslmode,
      searchParams: urlObj.search,
    });

    if (!urlObj.hostname) {
      throw new Error('Database URL must include a hostname');
    }

    if (!urlObj.pathname || urlObj.pathname === '/') {
      throw new Error('Database URL must include a database name');
    }

    // Normalize localhost to IPv4, and handle Docker networking
    let hostname = urlObj.hostname;
    const isDocker = process.env.DOCKER_ENV === 'true' || existsSync('/.dockerenv');

    if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname === '127.0.0.1') {
      hostname = isDocker ? 'host.docker.internal' : '127.0.0.1';
      logger.info('Normalized localhost in URL', {
        original: urlObj.hostname,
        normalized: hostname,
        isDocker
      });
    } else if (hostname === 'postgres' && !isDocker) {
      hostname = '127.0.0.1';
      logger.info('Normalized Docker hostname "postgres" to localhost', {
        original: urlObj.hostname,
        normalized: hostname
      });
    }

    return {
      user: decodedUser,
      password: decodedPassword,
      database: urlObj.pathname.slice(1),
      hostname: hostname,
      port: parseInt(urlObj.port) || 5432,
      ssl: sslmode === 'require',
    };
  } catch (error) {
    if (error instanceof CustomError) {
      throw error;
    }
    logger.error('Error parsing PostgreSQL URL:', { url, error });
    throw new CustomError(`Invalid PostgreSQL URL format ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`, 400);
  }
}

/** THE settings-pool cache key (formerly inlined in getClientSettingsPool). No
 *  password — rotation recreates the pool under the SAME key — and no query
 *  parameters, because parsePostgresUrl never forwards them to the connection. */
export function settingsPoolKey(config: DatabaseConfig): string {
  return `settings:${config.user}@${config.hostname}:${config.port}/${config.database}`;
}

/** URL → canonical identity in one step, for callers that hold only the URL.
 *  Throws (CustomError 400) on unparseable input, exactly like parsePostgresUrl —
 *  tenantKeyFor in chatStore.ts is the never-throw wrapper. */
export function settingsPoolKeyForUrl(url: string): string {
  return settingsPoolKey(parsePostgresUrl(url));
}

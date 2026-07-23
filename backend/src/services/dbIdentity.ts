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
 *
 * Round 4 (note 56582) extended the same rule to the network endpoint itself:
 * the WHATWG parser treats postgresql: as a non-special scheme and preserves
 * hostname case, the trailing root dot and numeric IPv4 shorthand, so
 * DB.EXAMPLE, db.example. and 127.1-style spellings each minted a fresh pool
 * key and rate-limit bucket. canonicalizeHostname collapses exactly the
 * spellings DNS and inet_aton collapse — and nothing Postgres matches
 * byte-for-byte (user and database names stay verbatim).
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

/** inet_aton's numeric grammar: 1–4 dot-separated C-style numbers (decimal, 0x
 *  hex, leading-0 octal), the last one filling every remaining byte. getaddrinfo
 *  accepts all of them as ADDRESSES — no DNS involved — so 127.1, 0x7f.0.0.1 and
 *  2130706433 all connect to 127.0.0.1 and must share its identity. Returns null
 *  when any part falls outside the grammar: that is a DNS name (or a dead
 *  string), and its spelling is left alone — finer is always safe. */
function ipv4FromNumericHost(hostname: string): string | null {
  const parts = hostname.split('.');
  if (parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (/^0x[0-9a-f]+$/.test(part)) values.push(parseInt(part.slice(2), 16));
    else if (/^0[0-7]*$/.test(part)) values.push(parseInt(part, 8));
    else if (/^[1-9][0-9]*$/.test(part)) values.push(parseInt(part, 10));
    else return null;
  }
  const tailBytes = 5 - values.length; // bytes the last number must fill
  const last = values[values.length - 1] ?? 0;
  if (last >= 2 ** (8 * tailBytes)) return null;
  if (values.slice(0, -1).some((v) => v > 255)) return null;
  let n = last;
  for (let i = 0; i < values.length - 1; i++) {
    n += (values[i] ?? 0) * 2 ** (8 * (3 - i));
  }
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** Collapse every hostname spelling that reaches the SAME network endpoint, and
 *  ONLY those (MR !61 round 4, note 56582). new URL() treats postgresql: as a
 *  non-special scheme and returns the host as an opaque string — case, trailing
 *  root dot and numeric IPv4 shorthand survive verbatim (bracketed IPv6 alone is
 *  canonicalized for every scheme). Left raw, each spelling minted its own pool
 *  AND its own 20/min rate-limit bucket. DNS names are case-insensitive and one
 *  trailing dot is the absolute-name anchor; numeric hosts follow inet_aton. */
function canonicalizeHostname(raw: string): string {
  let hostname = raw.toLowerCase();
  if (hostname.startsWith('[')) {
    // IPv6 literal — already canonical (lowercase, zero-compressed) courtesy of
    // the URL parser. An IPv4-mapped address reaches the IPv4 stack, so fold it
    // onto the dotted quad it actually connects to. Both serializations are
    // handled: the WHATWG form (::ffff:7f00:1) and the conventional dotted one.
    const hex = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(hostname);
    if (hex) {
      const hi = parseInt(hex[1] ?? '0', 16);
      const lo = parseInt(hex[2] ?? '0', 16);
      return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
    }
    const dotted = /^\[::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]$/.exec(hostname);
    const quad = dotted ? ipv4FromNumericHost(dotted[1] ?? '') : null;
    return quad ?? hostname;
  }
  // A single trailing dot is DNS's absolute-name anchor: db.example. and
  // db.example resolve identically. Doubled dots are not valid DNS — leave
  // them distinct; finer is always safe.
  if (hostname.endsWith('.') && !hostname.endsWith('..')) {
    hostname = hostname.slice(0, -1);
  }
  return ipv4FromNumericHost(hostname) ?? hostname;
}

/**
 * Parse a PostgreSQL URL and extract connection components.
 * Moved verbatim from DatabaseService (which still exposes it as a method);
 * round 4 added canonicalizeHostname on the endpoint.
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

    // Canonicalize the endpoint spelling, then normalize localhost to IPv4 and
    // handle Docker networking on the canonical form (so LOCALHOST., 127.1 and
    // [::ffff:127.0.0.1] all take the same branch as 127.0.0.1).
    let hostname = canonicalizeHostname(urlObj.hostname);
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
 *  parameters, because parsePostgresUrl never forwards them to the connection.
 *  The hostname arrives canonicalized (case, root dot, numeric IPv4 — round 4). */
export function settingsPoolKey(config: DatabaseConfig): string {
  return `settings:${config.user}@${config.hostname}:${config.port}/${config.database}`;
}

/** URL → canonical identity in one step, for callers that hold only the URL.
 *  Throws (CustomError 400) on unparseable input, exactly like parsePostgresUrl —
 *  tenantKeyFor in chatStore.ts is the never-throw wrapper. */
export function settingsPoolKeyForUrl(url: string): string {
  return settingsPoolKey(parsePostgresUrl(url));
}

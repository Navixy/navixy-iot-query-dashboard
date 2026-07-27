import type { Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { CustomError } from './errorHandler.js';
// TYPE-ONLY, and deliberately so: a value import of auth.js would drag in
// DatabaseService (and through it sqlSelectGuard's createRequire), which this
// repo's ts-jest ESM setup cannot load — the guard would become untestable.
import type { AuthenticatedRequest } from './auth.js';

/**
 * FAIL-CLOSED demo guard for routes that WRITE to the tenant settings DB
 * (review !62 round 10, Critical 2).
 *
 * Demo mode promises "no modifications will be saved to the database" — the
 * frontend keeps demo CRUD in IndexedDB and routes there only while the
 * ORIGIN-WIDE `demo_mode` localStorage flag is set. That flag and a tab's JWT
 * are separate pieces of shared state, so between a demo -> normal transition in
 * one tab and the moment another tab processes its storage event, a tab holding
 * a demo JWT reads a non-demo flag and sends its CRUD here. NO ordering of the
 * client-side writes can close that window: the tabs are not synchronized, and
 * the storage event is asynchronous. The promise therefore cannot be a
 * client-side convention — it has to be enforced where the write would happen.
 *
 * Place it directly after authenticateToken on EVERY route that writes to the
 * tenant settings DB, before any role check, so a demo JWT is rejected whatever
 * its role. demoWriteGuard.wiring.test.ts fails by name if a mutating route
 * forgets it; deliberate exceptions are listed there with their reasons.
 *
 * 403, not 401: the token is valid, the operation is not permitted for it.
 */
export const rejectDemoWrites = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void => {
  if (req.user?.demo === true) {
    logger.warn('Rejected a tenant-database write from a demo session', {
      userId: req.user.userId,
      path: req.path,
      method: req.method,
    });
    next(new CustomError('Demo mode cannot modify the database', 403));
    return;
  }
  next();
};

import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import { DatabaseService } from '../services/database.js';
import { logger } from '../utils/logger.js';
import { CustomError } from './errorHandler.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    role: string;
    iotDbUrl: string;
    userDbUrl: string;
    session_id?: string;
    /** True for demo-mode JWTs. Routes that WRITE to the tenant settings DB
     *  must check it: demo mode promises "no modifications will be saved to
     *  the database" (the frontend keeps demo CRUD in IndexedDB), and the
     *  agent chat store honours that server-side by degrading to its
     *  in-memory path (routes/agent.ts, DO-313 review !62). */
    demo?: boolean;
  };
  settingsPool?: Pool;
}

export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      throw new CustomError('Access token required', 401);
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') as jwt.JwtPayload & {
      userId: string;
      email: string;
      role?: string;
      iotDbUrl: string;
      userDbUrl: string;
      session_id?: string | number;
      demo?: boolean;
    };
    
    // Validate that both database URLs are present in the token
    if (!decoded.iotDbUrl) {
      throw new CustomError('Invalid token: missing iotDbUrl', 401);
    }
    if (!decoded.userDbUrl) {
      throw new CustomError('Invalid token: missing userDbUrl', 401);
    }

    // Get client settings pool from userDbUrl in JWT
    const dbService = DatabaseService.getInstance();
    const settingsPool = dbService.getClientSettingsPool(decoded.userDbUrl);

    // For demo mode, use role from token (user may be deleted after seed)
    // For normal mode, verify user still exists and get current role from DB
    let userRole: string;
    if (decoded.demo === true) {
      // Demo mode: trust the role from the token, don't check DB
      userRole = decoded.role || 'viewer';
      logger.debug('Demo mode: using role from token', { userId: decoded.userId, role: userRole });
    } else {
      // Normal mode: verify user exists and get role from DB
      userRole = await dbService.getUserRole(decoded.userId, settingsPool);
    }

    const sessionId = decoded.session_id != null ? String(decoded.session_id) : undefined;

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: userRole,
      iotDbUrl: decoded.iotDbUrl,
      userDbUrl: decoded.userDbUrl,
      ...(sessionId && { session_id: sessionId }),
      ...(decoded.demo === true && { demo: true }),
    };
    
    // Attach the settings pool to the request for use in routes
    req.settingsPool = settingsPool;

    logger.info('Authenticated request', {
      userId: decoded.userId,
      email: decoded.email,
      role: userRole,
      session_id: sessionId ?? 'not in token',
      demo: decoded.demo ?? false,
    });

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('Invalid JWT token:', error.message);
      next(new CustomError('Invalid token', 401));
    } else if (error instanceof CustomError) {
      next(error);
    } else {
      logger.error('Authentication error:', error);
      next(new CustomError('Authentication failed', 401));
    }
  }
};

export const requireRole = (requiredRoles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new CustomError('Authentication required', 401));
      return;
    }

    if (!requiredRoles.includes(req.user.role)) {
      logger.warn(`Access denied for user ${req.user.email} with role ${req.user.role}. Required: ${requiredRoles.join(', ')}`);
      next(new CustomError('Insufficient permissions', 403));
      return;
    }

    next();
  };
};

export const requireAdmin = requireRole(['admin']);
export const requireAdminOrEditor = requireRole(['admin', 'editor']);

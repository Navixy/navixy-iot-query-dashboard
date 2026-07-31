/**
 * The demo promise cannot be a client-side convention (review !62 round 10,
 * Critical 2). demo_mode is an ORIGIN-WIDE localStorage flag and each tab's JWT
 * is its own, so between a demo -> normal transition in one tab and the moment
 * another tab processes its storage event, a tab holding a demo JWT reads a
 * non-demo flag and sends its CRUD to the real backend. No ordering of the
 * client-side writes closes that window — the tabs are not synchronized — so the
 * guard has to live where the write would actually happen.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { Response, NextFunction } from 'express';
import { rejectDemoWrites } from '../demoGuard.js';
import type { AuthenticatedRequest } from '../auth.js';
import { CustomError } from '../errorHandler.js';

const requestFor = (user: AuthenticatedRequest['user']): AuthenticatedRequest =>
  ({ user, path: '/reports', method: 'POST' }) as AuthenticatedRequest;

const liveUser = {
  userId: 'u1',
  email: 'real@navixy.io',
  role: 'admin',
  iotDbUrl: 'postgres://iot',
  userDbUrl: 'postgres://settings',
};

describe('rejectDemoWrites', () => {
  it('rejects a demo JWT with 403, whatever its role', () => {
    const next = jest.fn() as unknown as NextFunction;
    rejectDemoWrites(requestFor({ ...liveUser, demo: true }), {} as Response, next);

    const error = (next as unknown as jest.Mock).mock.calls[0][0] as CustomError;
    expect(error).toBeInstanceOf(CustomError);
    expect(error.statusCode).toBe(403);
    // 403, not 401: the token is valid, the operation is not permitted for it.
    expect(error.message).toMatch(/demo/i);
  });

  it('passes a normal session through untouched', () => {
    const next = jest.fn() as unknown as NextFunction;
    rejectDemoWrites(requestFor({ ...liveUser, demo: false }), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('passes a session whose token predates the demo flag', () => {
    const next = jest.fn() as unknown as NextFunction;
    rejectDemoWrites(requestFor(liveUser), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('does not reject an unauthenticated request — authenticateToken owns that', () => {
    // Ordering matters: this guard runs AFTER authenticateToken, so a missing
    // user here means the route is unauthenticated by design, not demo.
    const next = jest.fn() as unknown as NextFunction;
    rejectDemoWrites({ path: '/x', method: 'POST' } as AuthenticatedRequest, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });
});

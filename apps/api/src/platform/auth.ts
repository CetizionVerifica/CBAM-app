import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sql } from 'kysely';
import {
  type MfaState,
  type Permission,
  ROLES_REQUIRING_MFA,
  type SessionUser,
  type UserRole,
  can,
} from '@cbam/shared';
import type { RequestContext } from './db';
import type { Db } from './db';
import { sha256Hex } from './crypto';
import { AppError } from './errors';

export const SESSION_COOKIE = 'cbam_session';

export interface AuthState {
  user: SessionUser;
  sessionHash: string;
  mfa: MfaState;
  /** Account locked after failed attempts; only sessions that passed 2FA carry on. */
  locked: boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthState;
    }
  }
}

export function mfaState(role: UserRole, totpEnabled: boolean, verified: boolean): MfaState {
  if (verified) return 'verified';
  if (totpEnabled) return 'required';
  return ROLES_REQUIRING_MFA.includes(role) ? 'setup_required' : 'not_required';
}

/** Resolves the session cookie on every request; never rejects by itself. */
export function authenticate(db: Db, idleMinutes: number): RequestHandler {
  return async (req, _res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length < 20) return next();
    const sessionHash = sha256Hex(token);
    const { rows } = await sql<{
      user_id: string;
      tenant_id: string;
      role: UserRole;
      email: string;
      display_name: string;
      mfa_verified: boolean;
      totp_enabled: boolean;
      locked: boolean;
    }>`select * from auth.session_lookup(${sessionHash}, ${idleMinutes})`.execute(db);
    const s = rows[0];
    if (s) {
      req.auth = {
        sessionHash,
        user: { id: s.user_id, tenantId: s.tenant_id, role: s.role, email: s.email, displayName: s.display_name },
        mfa: mfaState(s.role, s.totp_enabled, s.mfa_verified),
        locked: s.locked,
      };
    }
    next();
  };
}

/** Signed in, with 2FA done where it applies (M1-R5, AT3). */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const auth = req.auth;
  if (!auth) return next(new AppError(401, 'unauthenticated', 'Sign in to continue.'));
  if (auth.mfa === 'required') {
    return next(new AppError(403, 'mfa_required', 'Enter the code from your authenticator app to continue.'));
  }
  if (auth.mfa === 'setup_required') {
    return next(new AppError(403, 'mfa_setup_required', 'Set up two-factor authentication to continue.'));
  }
  next();
};

/** Signed in, 2FA not yet done: only the 2FA endpoints use this. */
export const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new AppError(401, 'unauthenticated', 'Sign in to continue.'));
  next();
};

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth || !can(req.auth.user.role, permission)) {
      return next(new AppError(403, 'forbidden', 'Your role does not allow this action.'));
    }
    next();
  };

/** The request context every data access runs under (G1, G3). */
export function contextOf(req: Request, action?: string, reason?: string): RequestContext {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  return {
    tenantId: auth.user.tenantId,
    userId: auth.user.id,
    userRole: auth.user.role,
    requestId: String(req.id ?? randomUUID()),
    action,
    reason,
  };
}

function originOf(req: Request): string | undefined {
  if (req.headers.origin) return req.headers.origin;
  if (!req.headers.referer) return undefined;
  try {
    return new URL(req.headers.referer).origin;
  } catch {
    return undefined; // malformed Referer is simply not our origin (review M1 F6)
  }
}

/**
 * CSRF defence for cookie sessions: state-changing requests must come from the web origin.
 * Combined with SameSite=Lax cookies.
 */
export function requireSameOrigin(webOrigin: string): RequestHandler {
  const allowed = new URL(webOrigin).origin;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (originOf(req) !== allowed) {
      return next(new AppError(403, 'bad_origin', 'This request did not come from the CBAM app.'));
    }
    next();
  };
}

import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { sql } from 'kysely';
import {
  AcceptInvitationRequest,
  LoginRequest,
  type MeResponse,
  MfaEnableRequest,
  MfaVerifyRequest,
  type UserRole,
} from '@cbam/shared';
import { SESSION_COOKIE, mfaState, requireAuth, requireSession } from '../../platform/auth';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '../../platform/totp';
import { type AccessDeps, LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from './deps';
import { dummyVerify, hashPassword, verifyPassword } from './passwords';

const BAD_CREDENTIALS = new AppError(401, 'bad_credentials', 'The email or password is not correct.');

export function authRouter({ db, config }: AccessDeps): Router {
  const router = Router();
  const key = Buffer.from(config.TOTP_ENCRYPTION_KEY, 'base64');
  const secure = config.NODE_ENV === 'production';

  // M1-R6: per-IP limit on top of the per-account lockout.
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.NODE_ENV === 'test' ? 1000 : 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'rate_limited', 'Too many attempts from this network. Wait 15 minutes and try again.')),
  });

  const client = (req: Request) => ({ ip: req.ip ?? null, ua: req.get('user-agent') ?? null });

  const logEvent = (req: Request, tenantId: string | null, userId: string | null, email: string | null, event: string, detail?: object) =>
    sql`select auth.log_event(${tenantId}, ${userId}, ${email}, ${event}, ${client(req).ip}, ${client(req).ua},
                              ${detail ? JSON.stringify(detail) : null}::jsonb)`.execute(db);

  const setSessionCookie = (res: Response, token: string) =>
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: config.SESSION_TTL_MINUTES * 60_000,
    });

  const me = (req: Request): MeResponse => ({ user: req.auth!.user, mfa: req.auth!.mfa });

  // --- Sign in -------------------------------------------------------------

  router.post('/login', limiter, async (req, res) => {
    const { email, password } = LoginRequest.parse(req.body);
    const { rows } = await sql<{
      user_id: string;
      tenant_id: string;
      role: UserRole;
      status: string;
      password_hash: string | null;
      totp_enabled: boolean;
      locked_until: Date | null;
    }>`select * from auth.login_lookup(${email})`.execute(db);
    const u = rows[0];

    if (!u || !u.password_hash) {
      await dummyVerify(password);
      await logEvent(req, u?.tenant_id ?? null, u?.user_id ?? null, email, 'login_failed', { reason: u ? 'not_activated' : 'unknown_email' });
      throw BAD_CREDENTIALS;
    }
    if (u.locked_until && u.locked_until > new Date()) {
      await logEvent(req, u.tenant_id, u.user_id, email, 'login_blocked_locked');
      throw new AppError(429, 'account_locked', `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);
    }
    const ok = await verifyPassword(u.password_hash, password);
    if (!ok || u.status !== 'active') {
      if (!ok) {
        const { rows: lock } = await sql<{ locked_until: Date | null }>`
          select auth.record_login_failure(${u.user_id}, ${MAX_FAILED_LOGINS}, ${LOCKOUT_MINUTES}) as locked_until`.execute(db);
        await logEvent(req, u.tenant_id, u.user_id, email, lock[0]?.locked_until ? 'account_locked' : 'login_failed', { reason: 'bad_password' });
      } else {
        await logEvent(req, u.tenant_id, u.user_id, email, 'login_failed', { reason: u.status });
      }
      throw BAD_CREDENTIALS;
    }

    const token = randomToken();
    await sql`select auth.create_session(${u.user_id}, ${sha256Hex(token)}, ${config.SESSION_TTL_MINUTES},
                                         ${client(req).ip}, ${client(req).ua})`.execute(db);
    await logEvent(req, u.tenant_id, u.user_id, email, 'login_succeeded');
    setSessionCookie(res, token);

    const { rows: users } = await sql<{ display_name: string; email: string }>`
      select * from auth.session_lookup(${sha256Hex(token)}, ${config.SESSION_IDLE_MINUTES})`.execute(db);
    res.json({
      user: { id: u.user_id, tenantId: u.tenant_id, email: users[0]!.email, displayName: users[0]!.display_name, role: u.role },
      mfa: mfaState(u.role, u.totp_enabled, false),
    } satisfies MeResponse);
  });

  router.post('/logout', requireSession, async (req, res) => {
    await sql`select auth.revoke_session(${req.auth!.sessionHash})`.execute(db);
    await logEvent(req, req.auth!.user.tenantId, req.auth!.user.id, req.auth!.user.email, 'logout');
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/me', requireSession, (req, res) => {
    res.json(me(req));
  });

  // --- Two-factor authentication (M1-R5) -------------------------------------

  // Refused by the database once 2FA is on; resetting it is an admin task, not self-service.
  router.post('/mfa/setup', requireSession, async (req, res) => {
    const secret = generateTotpSecret();
    try {
      await sql`select auth.set_pending_totp_secret(${req.auth!.sessionHash}, ${encryptSecret(secret, key)})`.execute(db);
    } catch (e) {
      if ((e as { code?: string }).code === '23514') {
        throw new AppError(409, 'mfa_already_enabled', 'Two-factor authentication is already on for this account.');
      }
      throw e;
    }
    res.json({ secret, otpauthUrl: otpauthUrl(secret, req.auth!.user.email, 'CBAM reporting') });
  });

  router.post('/mfa/enable', requireSession, limiter, async (req, res) => {
    const { code } = MfaEnableRequest.parse(req.body);
    const sealed = await totpSecret(req.auth!.sessionHash);
    if (!sealed) throw new AppError(409, 'mfa_not_started', 'Start two-factor set-up first.');
    if (!verifyTotp(decryptSecret(sealed, key), code)) {
      throw new AppError(400, 'bad_code', 'That code is not correct. Check the time on your phone and try again.');
    }
    const codes = generateRecoveryCodes();
    try {
      await sql`select auth.enable_totp(${req.auth!.sessionHash},
                  ${codes.map((c) => sha256Hex(normaliseRecoveryCode(c)))}::text[])`.execute(db);
    } catch (e) {
      if ((e as { code?: string }).code === '23514') {
        throw new AppError(409, 'mfa_already_enabled', 'Two-factor authentication is already on for this account.');
      }
      throw e;
    }
    await logEvent(req, req.auth!.user.tenantId, req.auth!.user.id, req.auth!.user.email, 'mfa_enabled');
    res.json({ recoveryCodes: codes });
  });

  router.post('/mfa/verify', requireSession, limiter, async (req, res) => {
    const body = MfaVerifyRequest.parse(req.body);
    const { user, sessionHash, mfa } = req.auth!;
    if (mfa === 'verified') return void res.json(me(req));
    if (mfa !== 'required') throw new AppError(409, 'mfa_not_enabled', 'Set up two-factor authentication first.');

    let ok: boolean;
    if ('code' in body) {
      const sealed = await totpSecret(sessionHash);
      ok = !!sealed && verifyTotp(decryptSecret(sealed, key), body.code);
      if (ok) await sql`select auth.mark_session_mfa_verified(${sessionHash})`.execute(db);
    } else {
      const { rows } = await sql<{ ok: boolean }>`
        select auth.use_recovery_code(${sessionHash}, ${sha256Hex(normaliseRecoveryCode(body.recoveryCode))}) as ok`.execute(db);
      ok = rows[0]?.ok === true;
    }

    if (!ok) {
      const { rows: lock } = await sql<{ locked_until: Date | null }>`
        select auth.record_login_failure(${user.id}, ${MAX_FAILED_LOGINS}, ${LOCKOUT_MINUTES}) as locked_until`.execute(db);
      await logEvent(req, user.tenantId, user.id, user.email, 'mfa_failed');
      if (lock[0]?.locked_until) {
        await sql`select auth.revoke_session(${sessionHash})`.execute(db);
        res.clearCookie(SESSION_COOKIE, { path: '/' });
        throw new AppError(429, 'account_locked', `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);
      }
      throw new AppError(400, 'bad_code', 'That code is not correct. Try again, or use a recovery code.');
    }
    await logEvent(req, user.tenantId, user.id, user.email, 'code' in body ? 'mfa_verified' : 'mfa_recovery_code_used');
    res.json({ user, mfa: 'verified' } satisfies MeResponse);
  });

  const totpSecret = async (sessionHash: string) => {
    const { rows } = await sql<{ s: string | null }>`select auth.get_totp_secret(${sessionHash}) as s`.execute(db);
    return rows[0]?.s ?? null;
  };

  // --- Invitations (M1-R4) --------------------------------------------------

  router.get('/invitations/:token', limiter, async (req, res) => {
    const { rows } = await sql<{ email: string; display_name: string; role: UserRole; tenant_name: string; expires_at: Date }>`
      select * from auth.invitation_lookup(${sha256Hex(String(req.params.token))})`.execute(db);
    const inv = rows[0];
    if (!inv) throw invalidInvitation();
    res.json({ email: inv.email, displayName: inv.display_name, role: inv.role, organisation: inv.tenant_name, expiresAt: inv.expires_at });
  });

  router.post('/invitations/accept', limiter, async (req, res) => {
    const body = AcceptInvitationRequest.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    try {
      const { rows } = await sql<{ user_id: string }>`
        select auth.accept_invitation(${sha256Hex(body.token)}, ${body.displayName}, ${passwordHash}) as user_id`.execute(db);
      await logEvent(req, null, rows[0]!.user_id, null, 'invitation_accepted');
    } catch (e) {
      if ((e as { code?: string }).code === 'P0002') throw invalidInvitation();
      throw e;
    }
    res.status(204).end();
  });

  // Signed-in check with 2FA complete; used by the UI after sign-in.
  router.get('/session', requireAuth, (req, res) => res.json(me(req)));

  return router;
}

const invalidInvitation = () =>
  new AppError(
    410,
    'invitation_invalid',
    'This invitation link has expired or has already been used. Ask the person who invited you to send a new one.',
  );

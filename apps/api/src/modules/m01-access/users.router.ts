import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DeactivateUserRequest,
  INVITABLE_ROLES,
  InviteUserRequest,
  ROLE_LABELS,
  UpdateUserRequest,
  type UserRole,
  type UserSummary,
} from '@cbam/shared';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { randomToken, sha256Hex } from '../../platform/crypto';
import { type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import type { AccessDeps } from './deps';

const UserId = z.uuid();

const notFound = () => new AppError(404, 'not_found', 'This user does not exist.');

const parseUserId = (raw: unknown): string => {
  const r = UserId.safeParse(raw);
  if (!r.success) throw notFound();
  return r.data;
};

const summary = (u: {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  status: UserSummary['status'];
  totp_enabled_at: Date | null;
  created_at: Date;
}): UserSummary => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  role: u.role,
  status: u.status,
  twoFactorEnabled: u.totp_enabled_at !== null,
  createdAt: u.created_at.toISOString(),
});

const USER_COLUMNS = ['id', 'email', 'display_name', 'role', 'status', 'totp_enabled_at', 'created_at'] as const;

export function usersRouter({ db, mailer, config }: AccessDeps): Router {
  const router = Router();
  router.use(requireAuth);

  const loadUser = async (tx: Tx, id: string) => {
    const u = await tx.selectFrom('app_user').select(USER_COLUMNS).where('id', '=', id).executeTakeFirst();
    if (!u) throw notFound();
    return u;
  };

  /** Creates a fresh invitation (revoking any open one) and returns the raw token. */
  const issueInvitation = async (tx: Tx, userId: string, tenantId: string) => {
    await tx
      .updateTable('invitation')
      .set({ revoked_at: sql`now()` })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();
    const token = randomToken();
    const expiresAt = new Date(Date.now() + config.INVITATION_TTL_HOURS * 3_600_000);
    await tx
      .insertInto('invitation')
      .values({ tenant_id: tenantId, user_id: userId, token_hash: sha256Hex(token), expires_at: expiresAt })
      .execute();
    return { token, expiresAt };
  };

  const sendInvitation = (to: string, displayName: string, role: UserRole, inviter: string, token: string, expiresAt: Date) =>
    mailer.send({
      to,
      subject: 'You have been invited to CBAM reporting',
      text: [
        `Hello ${displayName},`,
        '',
        `${inviter} has invited you to CBAM reporting as ${ROLE_LABELS[role].toLowerCase()}.`,
        'Open this link to set your password:',
        `${config.WEB_ORIGIN}/invitation/${token}`,
        '',
        `The link works once and expires on ${expiresAt.toUTCString()}.`,
      ].join('\n'),
    });

  router.get('/', requirePermission('users.list'), async (req, res) => {
    const users = await withContext(db, contextOf(req), (tx) =>
      tx.selectFrom('app_user').select(USER_COLUMNS).orderBy('display_name').execute(),
    );
    res.json({ users: users.map(summary) });
  });

  router.get('/:id', requirePermission('users.list'), async (req, res) => {
    const id = parseUserId(req.params.id);
    const user = await withContext(db, contextOf(req), (tx) => loadUser(tx, id));
    res.json({ user: summary(user) });
  });

  router.post('/invitations', requirePermission('users.invite'), async (req, res) => {
    const body = InviteUserRequest.parse(req.body);
    const inviter = req.auth!.user;
    if (!INVITABLE_ROLES[inviter.role].includes(body.role)) {
      throw new AppError(403, 'forbidden', `Your role cannot invite a ${ROLE_LABELS[body.role].toLowerCase()}.`);
    }
    const { user, token, expiresAt } = await withContext(db, contextOf(req, 'Invite user'), async (tx) => {
      const created = await tx
        .insertInto('app_user')
        .values({ tenant_id: inviter.tenantId, email: body.email, display_name: body.displayName, role: body.role })
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow()
        .catch((e: { code?: string }) => {
          if (e.code === '23505') throw new AppError(409, 'email_taken', 'A user with this email address already exists.');
          throw e;
        });
      return { user: created, ...(await issueInvitation(tx, created.id, inviter.tenantId)) };
    });
    await sendInvitation(user.email, user.display_name, user.role, inviter.displayName, token, expiresAt);
    res.status(201).json({ user: summary(user), invitationExpiresAt: expiresAt.toISOString() });
  });

  router.post('/:id/invitations', requirePermission('users.invite'), async (req, res) => {
    const id = parseUserId(req.params.id);
    const inviter = req.auth!.user;
    const { user, token, expiresAt } = await withContext(db, contextOf(req, 'Resend invitation'), async (tx) => {
      const u = await loadUser(tx, id);
      if (u.status !== 'invited') {
        throw new AppError(409, 'not_invited', 'This user has already accepted their invitation.');
      }
      if (!INVITABLE_ROLES[inviter.role].includes(u.role)) throw notFound();
      return { user: u, ...(await issueInvitation(tx, u.id, inviter.tenantId)) };
    });
    await sendInvitation(user.email, user.display_name, user.role, inviter.displayName, token, expiresAt);
    res.json({ user: summary(user), invitationExpiresAt: expiresAt.toISOString() });
  });

  // M1-R8: role changes land in the audit log through the table trigger.
  router.patch('/:id', requirePermission('users.update'), async (req, res) => {
    const id = parseUserId(req.params.id);
    const body = UpdateUserRequest.parse(req.body);
    if (id === req.auth!.user.id && body.role !== undefined && body.role !== req.auth!.user.role) {
      throw new AppError(409, 'own_role', 'You cannot change your own role. Ask another platform admin.');
    }
    const action = body.role !== undefined ? 'Change role' : 'Rename user';
    const user = await withContext(db, contextOf(req, action), async (tx) => {
      await loadUser(tx, id);
      return tx
        .updateTable('app_user')
        .set({
          ...(body.displayName !== undefined && { display_name: body.displayName }),
          ...(body.role !== undefined && { role: body.role }),
        })
        .where('id', '=', id)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
    });
    res.json({ user: summary(user) });
  });

  // M1-R7: sessions are revoked in the same transaction; audit history stays.
  router.post('/:id/deactivate', requirePermission('users.deactivate'), async (req, res) => {
    const id = parseUserId(req.params.id);
    const { reason } = DeactivateUserRequest.parse(req.body);
    if (id === req.auth!.user.id) {
      throw new AppError(409, 'deactivate_self', 'You cannot deactivate your own account.');
    }
    const user = await withContext(db, contextOf(req, 'Deactivate user', reason), async (tx) => {
      const u = await loadUser(tx, id);
      if (u.status === 'deactivated') return u;
      await tx
        .updateTable('invitation')
        .set({ revoked_at: sql`now()` })
        .where('user_id', '=', id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();
      const updated = await tx
        .updateTable('app_user')
        .set({ status: 'deactivated', deactivated_at: sql`now()` })
        .where('id', '=', id)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
      await sql`select auth.revoke_user_sessions(${id})`.execute(tx);
      return updated;
    });
    res.json({ user: summary(user) });
  });

  router.post('/:id/reactivate', requirePermission('users.deactivate'), async (req, res) => {
    const id = parseUserId(req.params.id);
    const user = await withContext(db, contextOf(req, 'Reactivate user'), async (tx) => {
      const u = await loadUser(tx, id);
      if (u.status !== 'deactivated') return u;
      const { password_hash } = await tx
        .selectFrom('app_user')
        .select('password_hash')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return tx
        .updateTable('app_user')
        .set({ status: password_hash ? 'active' : 'invited', deactivated_at: null })
        .where('id', '=', id)
        .returning(USER_COLUMNS)
        .executeTakeFirstOrThrow();
    });
    res.json({ user: summary(user) });
  });

  return router;
}

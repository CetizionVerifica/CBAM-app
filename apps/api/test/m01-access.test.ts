import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomToken, sha256Hex } from '../src/platform/crypto';
import { withContext } from '../src/platform/db';
import { totpAt } from '../src/platform/totp';
import {
  PASSWORD,
  type TestAgent,
  acceptInvitation,
  adminOfNewTenant,
  agent,
  bootstrapTenant,
  inviteAndAccept,
  signIn,
  signInWithMfa,
  testApp,
  tokenFromMail,
} from './helpers';

// M1 — Tenant and access. Requirement and acceptance-test IDs from
// .claude/skills/cbam-module-reviewer/references/modules/M01-tenant-access.md

const t = testApp();
let admin: Awaited<ReturnType<typeof adminOfNewTenant>>;

beforeAll(async () => {
  admin = await adminOfNewTenant(t);
});

afterAll(() => t.close());

const auditFor = (recordId: string) =>
  withContext(
    t.db,
    { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin', requestId: randomUUID() },
    (tx) => tx.selectFrom('audit.audit_log').selectAll().where('record_id', '=', recordId).orderBy('id').execute(),
  );

describe('M1-R1 roles', () => {
  it('can invite and activate each of the five roles', async () => {
    for (const role of ['consultant', 'contributor', 'reviewer', 'recipient', 'platform_admin'] as const) {
      const u = await inviteAndAccept(t, admin.a, role);
      const res = await admin.a.get(`/api/v1/users/${u.id}`);
      expect(res.body.user).toMatchObject({ role, status: 'active' });
    }
  });

  it('rejects an unknown role', async () => {
    const res = await admin.a.post('/api/v1/users/invitations', { email: 'x@example.test', displayName: 'X', role: 'superuser' });
    expect(res.status).toBe(400);
  });
});

describe('M1-R4 invitations', () => {
  it('sends a single-use link and stores only the token hash', async () => {
    const email = `new-${randomUUID().slice(0, 8)}@example.test`;
    const res = await admin.a.post('/api/v1/users/invitations', { email, displayName: 'Nia New', role: 'contributor' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, status: 'invited', twoFactorEnabled: false });

    const token = tokenFromMail(t, email);
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from audit.audit_log where new_row::text like ${'%' + token + '%'}`.execute(t.su);
    expect(rows[0]!.n).toBe(0);

    const preview = await agent(t).get(`/api/v1/auth/invitations/${token}`);
    expect(preview.body).toMatchObject({ email, role: 'contributor' });
  });

  it('AT4: a reused invitation token is rejected', async () => {
    const email = `reuse-${randomUUID().slice(0, 8)}@example.test`;
    await admin.a.post('/api/v1/users/invitations', { email, displayName: 'Rae Reuse', role: 'reviewer' });
    const token = tokenFromMail(t, email);
    await acceptInvitation(t, token);

    const again = await agent(t).post('/api/v1/auth/invitations/accept', { token, displayName: 'Mallory', password: 'another password 123' });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('invitation_invalid');

    // The first password still works; the second attempt changed nothing.
    const { res } = await signIn(t, email);
    expect(res.status).toBe(200);
  });

  it('AT4: two simultaneous accepts of one token — exactly one wins', async () => {
    const email = `race-${randomUUID().slice(0, 8)}@example.test`;
    await admin.a.post('/api/v1/users/invitations', { email, displayName: 'Rex Race', role: 'recipient' });
    const token = tokenFromMail(t, email);
    const results = await Promise.all(
      [1, 2, 3].map(() => agent(t).post('/api/v1/auth/invitations/accept', { token, displayName: 'R', password: PASSWORD })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([204, 410, 410]);
  });

  it('rejects expired invitations', async () => {
    // Created through the normal RLS path, as the admin, with a one-second lifetime.
    const token = randomToken();
    await withContext(
      t.db,
      { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin', requestId: randomUUID() },
      async (tx) => {
        const u = await tx
          .insertInto('app_user')
          .values({ tenant_id: admin.tenantId, email: `late-${randomUUID().slice(0, 8)}@example.test`, display_name: 'Lee Late', role: 'contributor' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('invitation')
          .values({ tenant_id: admin.tenantId, user_id: u.id, token_hash: sha256Hex(token), expires_at: sql`now() + interval '1 second'` })
          .execute();
      },
    );
    expect((await agent(t).get(`/api/v1/auth/invitations/${token}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    const res = await agent(t).post('/api/v1/auth/invitations/accept', { token, displayName: 'L', password: PASSWORD });
    expect(res.status).toBe(410);
  });

  it('resending revokes the previous link', async () => {
    const email = `resend-${randomUUID().slice(0, 8)}@example.test`;
    const created = await admin.a.post('/api/v1/users/invitations', { email, displayName: 'Rita Resend', role: 'contributor' });
    const first = tokenFromMail(t, email);
    expect((await admin.a.post(`/api/v1/users/${created.body.user.id}/invitations`)).status).toBe(200);
    const second = tokenFromMail(t, email);
    expect(second).not.toBe(first);
    expect((await agent(t).get(`/api/v1/auth/invitations/${first}`)).status).toBe(410);
    await acceptInvitation(t, second);
  });

  it('rejects weak passwords with the rule in plain words', async () => {
    const email = `weak-${randomUUID().slice(0, 8)}@example.test`;
    await admin.a.post('/api/v1/users/invitations', { email, displayName: 'W', role: 'contributor' });
    const res = await agent(t).post('/api/v1/auth/invitations/accept', { token: tokenFromMail(t, email), displayName: 'W', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].message).toBe('Use at least 12 characters.');
  });

  it('refuses a second user with the same email', async () => {
    const res = await admin.a.post('/api/v1/users/invitations', { email: admin.email, displayName: 'Dup', role: 'contributor' });
    expect(res.status).toBe(409);
  });
});

describe('M1-R5 two-factor authentication', () => {
  let consultantEmail: string;

  beforeAll(async () => {
    consultantEmail = (await inviteAndAccept(t, admin.a, 'consultant')).email;
  });

  it('AT3: a consultant without 2FA cannot reach data', async () => {
    const { a, res } = await signIn(t, consultantEmail);
    expect(res.body.mfa).toBe('setup_required');
    const users = await a.get('/api/v1/users');
    expect(users.status).toBe(403);
    expect(users.body.error.code).toBe('mfa_setup_required');
  });

  it('after set-up, a new sign-in needs the code before data', async () => {
    const { secret } = await signInWithMfa(t, consultantEmail);

    const { a, res } = await signIn(t, consultantEmail);
    expect(res.body.mfa).toBe('required');
    expect((await a.get('/api/v1/users')).status).toBe(403);

    expect((await a.post('/api/v1/auth/mfa/verify', { code: '000000' })).status).toBe(400);
    const ok = await a.post('/api/v1/auth/mfa/verify', { code: totpAt(secret, Date.now()) });
    expect(ok.status).toBe(200);
    expect((await a.get('/api/v1/users')).status).toBe(200);
  });

  it('cannot be re-initialised from a session that has not passed 2FA', async () => {
    const { a } = await signIn(t, consultantEmail);
    const res = await a.post('/api/v1/auth/mfa/setup');
    expect(res.status).toBe(409);
  });

  it('accepts each recovery code once', async () => {
    const u = await inviteAndAccept(t, admin.a, 'platform_admin');
    const { recoveryCodes } = await signInWithMfa(t, u.email);
    expect(recoveryCodes).toHaveLength(10);

    const first = await signIn(t, u.email);
    expect((await first.a.post('/api/v1/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(200);
    const second = await signIn(t, u.email);
    expect((await second.a.post('/api/v1/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(400);
  });

  it('is optional for contributors', async () => {
    const u = await inviteAndAccept(t, admin.a, 'contributor');
    const { res } = await signIn(t, u.email);
    expect(res.body.mfa).toBe('not_required');
  });

  it('stores the TOTP secret encrypted and never in the audit log', async () => {
    const { rows } = await sql<{ enc: string; audit: string }>`
      select u.totp_secret_enc as enc,
             (select string_agg(coalesce(new_row::text, ''), ' ') from audit.audit_log where record_id = u.id::text) as audit
        from app_user u where email = ${consultantEmail}`.execute(t.su);
    expect(rows[0]!.enc).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(rows[0]!.audit).not.toContain(rows[0]!.enc);
    expect(rows[0]!.audit).toContain('[redacted]');
  });
});

describe('M1-R6 passwords and lockout', () => {
  it('stores argon2id hashes, never the password', async () => {
    const { rows } = await sql<{ h: string }>`select password_hash as h from app_user where email = ${admin.email}`.execute(t.su);
    expect(rows[0]!.h).toMatch(/^\$argon2id\$/);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const unknown = await signIn(t, 'nobody@example.test', PASSWORD);
    const wrong = await signIn(t, admin.email, 'wrong password!!');
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.body).toEqual(wrong.res.body);
  });

  it('locks the account after 5 failed attempts, even for the right password', async () => {
    const u = await inviteAndAccept(t, admin.a, 'reviewer');
    for (let i = 0; i < 5; i++) expect((await signIn(t, u.email, 'wrong password!!')).res.status).toBe(401);
    const locked = await signIn(t, u.email);
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.error.message).toBe('Too many failed attempts. Try again in 15 minutes.');
  });

  it('records sign-in events outside the business audit log', async () => {
    const { rows } = await sql<{ event: string }>`
      select event from auth.auth_event where email = ${admin.email} order by id`.execute(t.su);
    expect(rows.map((r) => r.event)).toEqual(expect.arrayContaining(['login_succeeded', 'mfa_enabled', 'login_failed']));
  });
});

describe('M1-R7 deactivation', () => {
  it('revokes live sessions immediately and keeps audit history', async () => {
    const u = await inviteAndAccept(t, admin.a, 'contributor');
    const { a } = await signIn(t, u.email);
    expect((await a.get('/api/v1/auth/me')).status).toBe(200);

    const res = await admin.a.post(`/api/v1/users/${u.id}/deactivate`, { reason: 'Left the company' });
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('deactivated');

    expect((await a.get('/api/v1/auth/me')).status).toBe(401);
    expect((await signIn(t, u.email)).res.status).toBe(401);

    const history = await auditFor(u.id);
    expect(history.map((h) => h.action)).toEqual(['Invite user', 'Accept invitation', 'Deactivate user']);
    expect(history.at(-1)).toMatchObject({ reason: 'Left the company', changed_fields: ['deactivated_at', 'status'] });
  });

  it('can be reversed; the user signs in again', async () => {
    const u = await inviteAndAccept(t, admin.a, 'contributor');
    await admin.a.post(`/api/v1/users/${u.id}/deactivate`, { reason: 'Mistake' });
    expect((await admin.a.post(`/api/v1/users/${u.id}/reactivate`)).body.user.status).toBe('active');
    expect((await signIn(t, u.email)).res.status).toBe(200);
  });

  it('refuses to deactivate yourself', async () => {
    const res = await admin.a.post(`/api/v1/users/${admin.adminId}/deactivate`, { reason: 'x' });
    expect(res.status).toBe(409);
  });
});

describe('M1-R8 role changes are audited', () => {
  it('records old and new role, actor and verb', async () => {
    const u = await inviteAndAccept(t, admin.a, 'contributor');
    const res = await admin.a.patch(`/api/v1/users/${u.id}`, { role: 'reviewer' });
    expect(res.body.user.role).toBe('reviewer');
    const last = (await auditFor(u.id)).at(-1)!;
    expect(last).toMatchObject({ action: 'Change user role', actor_user_id: admin.adminId, changed_fields: ['role'] });
    expect(last.old_row).toMatchObject({ role: 'contributor' });
    expect(last.new_row).toMatchObject({ role: 'reviewer' });
  });

  it('refuses to change your own role', async () => {
    const res = await admin.a.patch(`/api/v1/users/${admin.adminId}`, { role: 'consultant' });
    expect(res.status).toBe(409);
  });
});

describe('M1-R3 role checks on the server (G2)', () => {
  let contributor: TestAgent;
  let recipient: TestAgent;
  let consultant: TestAgent;
  let consultantId: string;

  beforeAll(async () => {
    contributor = (await signIn(t, (await inviteAndAccept(t, admin.a, 'contributor')).email)).a;
    recipient = (await signIn(t, (await inviteAndAccept(t, admin.a, 'recipient')).email)).a;
    const c = await inviteAndAccept(t, admin.a, 'consultant');
    consultantId = c.id;
    consultant = (await signInWithMfa(t, c.email)).a;
  });

  it('AT2: a recipient cannot POST', async () => {
    const res = await recipient.post('/api/v1/users/invitations', { email: 'r@example.test', displayName: 'R', role: 'contributor' });
    expect(res.status).toBe(403);
  });

  it('a contributor cannot list or change users', async () => {
    expect((await contributor.get('/api/v1/users')).status).toBe(403);
    expect((await contributor.patch(`/api/v1/users/${admin.adminId}`, { role: 'contributor' })).status).toBe(403);
  });

  it('a consultant can invite client-side roles but not staff roles', async () => {
    const ok = await consultant.post('/api/v1/users/invitations', {
      email: `c-inv-${randomUUID().slice(0, 8)}@example.test`, displayName: 'Plant Person', role: 'contributor',
    });
    expect(ok.status).toBe(201);
    const staff = await consultant.post('/api/v1/users/invitations', {
      email: `c-staff-${randomUUID().slice(0, 8)}@example.test`, displayName: 'Nope', role: 'consultant',
    });
    expect(staff.status).toBe(403);
  });

  it('a consultant sees only themselves and users they invited', async () => {
    const res = await consultant.get('/api/v1/users');
    const creators = await sql<{ id: string }>`
      select id from app_user where created_by = ${consultantId} or id = ${consultantId}`.execute(t.su);
    expect(res.body.users.map((u: { id: string }) => u.id).sort()).toEqual(creators.rows.map((r) => r.id).sort());
    expect((await consultant.get(`/api/v1/users/${admin.adminId}`)).status).toBe(404);
  });

  it('the database refuses a consultant inserting a staff role even if the API check is bypassed', async () => {
    await expect(
      withContext(t.db, { tenantId: admin.tenantId, userId: consultantId, userRole: 'consultant', requestId: randomUUID() }, (tx) =>
        tx.insertInto('app_user').values({ tenant_id: admin.tenantId, email: 'bypass@example.test', display_name: 'B', role: 'platform_admin' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('unauthenticated requests get 401', async () => {
    expect((await request(t.app).get('/api/v1/users')).status).toBe(401);
  });

  it('writes from another origin are refused (CSRF)', async () => {
    const res = await admin.a.raw.post('/api/v1/users/invitations').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('bad_origin');
  });
});

describe('G1 tenant isolation', () => {
  it('an admin of another tenant sees none of this tenant\'s users', async () => {
    const other = await adminOfNewTenant(t);
    const list = await other.a.get('/api/v1/users');
    expect(list.body.users.map((u: { email: string }) => u.email)).toEqual([other.email]);
    expect((await other.a.get(`/api/v1/users/${admin.adminId}`)).status).toBe(404);
    expect((await other.a.patch(`/api/v1/users/${admin.adminId}`, { displayName: 'Hijacked' })).status).toBe(404);
    expect((await other.a.post(`/api/v1/users/${admin.adminId}/deactivate`, { reason: 'x' })).status).toBe(404);
  });

  it('the app role cannot read auth internals directly', async () => {
    await expect(sql`select * from auth.session`.execute(t.db)).rejects.toThrow(/permission denied/);
    await expect(sql`select * from auth.auth_event`.execute(t.db)).rejects.toThrow(/permission denied/);
  });

  it('the app role cannot call the bootstrap function', async () => {
    await expect(bootstrapTenant(t.db)).rejects.toThrow(/permission denied/);
  });

  it('no auth function is executable by PUBLIC', async () => {
    const { rows } = await sql<{ fn: string }>`
      select p.oid::regprocedure::text as fn
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'auth'
         and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`.execute(t.su);
    expect(rows).toEqual([]);
  });

  it('only the intended auth functions are executable by the app role', async () => {
    const { rows } = await sql<{ fn: string }>`
      select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'auth' and has_function_privilege('cbam_app', p.oid, 'execute')
       order by 1`.execute(t.su);
    expect(rows.map((r) => r.fn)).not.toEqual(expect.arrayContaining(['bootstrap_tenant']));
    expect(rows.map((r) => r.fn)).not.toEqual(expect.arrayContaining(['act_as']));
    expect(rows.map((r) => r.fn)).not.toEqual(expect.arrayContaining(['session_user']));
  });
});

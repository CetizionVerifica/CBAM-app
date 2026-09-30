import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { pino } from 'pino';
import request from 'supertest';
import { expect, inject } from 'vitest';
import type { UserRole } from '@cbam/shared';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { randomToken, sha256Hex } from '../src/platform/crypto';
import { type Db, createDb } from '../src/platform/db';
import { memoryMailer } from '../src/platform/mailer';
import { memoryFileStore } from '../src/platform/storage';
import { totpAt } from '../src/platform/totp';

export const WEB_ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';

export function testConfig(): Config {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    APP_DATABASE_URL: inject('appUrl'),
    WEB_ORIGIN,
    TRUST_PROXY: false,
    LOG_LEVEL: 'silent',
    TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SMTP_URL: 'smtp://localhost:1025',
    MAIL_FROM: 'test@localhost',
    SESSION_TTL_MINUTES: 720,
    SESSION_IDLE_MINUTES: 120,
    INVITATION_TTL_HOURS: 72,
    CLOUDINARY_FOLDER: 'cbam-test',
  };
}

export function testApp() {
  const config = testConfig();
  const db = createDb(config.APP_DATABASE_URL);
  const owner = createDb(inject('ownerUrl'));
  const su = createDb(inject('superUrl'));
  const mailer = memoryMailer();
  const files = memoryFileStore();
  const app = createApp({ db, logger: pino({ level: 'silent' }), mailer, files, config });
  const close = () => Promise.all([db.destroy(), owner.destroy(), su.destroy()]);
  return { app, db, owner, su, mailer, files, config, close };
}

export type TestApp = ReturnType<typeof testApp>;
export type Agent = ReturnType<typeof request.agent>;

/** Supertest agent that keeps cookies and sends the web origin on writes. */
export function agent(t: TestApp) {
  const a = request.agent(t.app);
  return {
    raw: a,
    get: (url: string) => a.get(url),
    post: (url: string, body?: object) => a.post(url).set('Origin', WEB_ORIGIN).send(body ?? {}),
    patch: (url: string, body?: object) => a.patch(url).set('Origin', WEB_ORIGIN).send(body ?? {}),
  };
}
export type TestAgent = ReturnType<typeof agent>;

/** The CLI bootstrap path: a new tenant with an invited platform admin. */
export async function bootstrapTenant(owner: Db) {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const email = `admin@${slug}.test`;
  const token = randomToken();
  const { rows } = await sql<{ tenant_id: string; user_id: string }>`
    select * from auth.bootstrap_tenant(${`Tenant ${slug}`}, ${slug}, ${email}, 'Ada Admin',
                                        ${sha256Hex(token)}, now() + interval '1 hour')`.execute(owner);
  return { tenantId: rows[0]!.tenant_id, adminId: rows[0]!.user_id, email, token, slug };
}

export async function acceptInvitation(t: TestApp, token: string, displayName = 'Test User') {
  const res = await agent(t).post('/api/v1/auth/invitations/accept', { token, displayName, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(204);
}

export async function signIn(t: TestApp, email: string, password = PASSWORD) {
  const a = agent(t);
  const res = await a.post('/api/v1/auth/login', { email, password });
  return { a, res };
}

/** Signs in and completes 2FA set-up; returns the agent and TOTP secret. */
export async function signInWithMfa(t: TestApp, email: string) {
  const { a, res } = await signIn(t, email);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const setup = await a.post('/api/v1/auth/mfa/setup');
  expect(setup.status).toBe(200);
  const secret: string = setup.body.secret;
  const enable = await a.post('/api/v1/auth/mfa/enable', { code: totpAt(secret, Date.now()) });
  expect(enable.status, JSON.stringify(enable.body)).toBe(200);
  return { a, secret, recoveryCodes: enable.body.recoveryCodes as string[] };
}

/**
 * A valid code for the next time step. The current step was used at enrolment, and a
 * step is accepted only once (replay protection), so the next sign-in uses step + 1.
 */
export const nextCode = (secret: string) => totpAt(secret, Date.now() + 30_000);

/** Last invitation token sent to an address (from the in-memory mailer). */
export function tokenFromMail(t: TestApp, email: string): string {
  const mail = [...t.mailer.sent].reverse().find((m) => m.to === email);
  const match = mail?.text.match(/\/invitation\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No invitation mail for ${email}`);
  return match[1]!;
}

/** A signed-in admin of a fresh tenant, 2FA done. */
export async function adminOfNewTenant(t: TestApp) {
  const tenant = await bootstrapTenant(t.owner);
  await acceptInvitation(t, tenant.token, 'Ada Admin');
  const { a, secret } = await signInWithMfa(t, tenant.email);
  return { ...tenant, a, secret };
}

/** Admin invites a user with the given role; the user accepts. Returns their email and id. */
export async function inviteAndAccept(t: TestApp, inviter: TestAgent, role: UserRole, name = `${role} user`) {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await inviter.post('/api/v1/users/invitations', { email, displayName: name, role });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await acceptInvitation(t, tokenFromMail(t, email), name);
  return { email, id: res.body.user.id as string };
}

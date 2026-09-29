import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../src/platform/db';
import {
  type TestAgent,
  adminOfNewTenant,
  inviteAndAccept,
  signIn,
  signInWithMfa,
  testApp,
} from './helpers';

// M2 — Client and installation registry, plus M1 AT1 and the M1 F5 carry-over.
// Requirement IDs from .claude/skills/cbam-module-reviewer/references/modules/M02-client-installation.md

const t = testApp();
let admin: Awaited<ReturnType<typeof adminOfNewTenant>>;
let consultant: { a: TestAgent; id: string; email: string };

const clientBody = (over: Record<string, unknown> = {}) => ({
  legalName: `Aurum Metals ${randomUUID().slice(0, 6)}`,
  addressLine1: '12 Marine Drive',
  city: 'Mumbai',
  countryCode: 'IN',
  contactName: 'Ravi Mehta',
  contactEmail: 'ravi@aurum.example',
  ...over,
});

const installationBody = (over: Record<string, unknown> = {}) => ({
  nameEn: `Smelter ${randomUUID().slice(0, 6)}`,
  street: 'Plot 4, GIDC',
  city: 'Jamnagar',
  countryCode: 'IN',
  unLocode: 'INJGA',
  latitude: '22.470000',
  longitude: '70.057700',
  ...over,
});

async function newClient(a: TestAgent, over: Record<string, unknown> = {}) {
  const res = await a.post('/api/v1/clients', clientBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.client as { id: string; legalName: string };
}

async function newInstallation(a: TestAgent, clientId: string, over: Record<string, unknown> = {}) {
  const res = await a.post(`/api/v1/clients/${clientId}/installations`, installationBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.installation as { id: string; clientId: string; countryCode: string };
}

beforeAll(async () => {
  admin = await adminOfNewTenant(t);
  const c = await inviteAndAccept(t, admin.a, 'consultant', 'Cara Consultant');
  consultant = { ...(await signInWithMfa(t, c.email)), ...c };
});

afterAll(() => t.close());

describe('M2-R1 clients, installations, importers', () => {
  it('a client has several installations and importers', async () => {
    const client = await newClient(consultant.a);
    await newInstallation(consultant.a, client.id);
    await newInstallation(consultant.a, client.id);
    await consultant.a.post(`/api/v1/clients/${client.id}/importers`, { name: 'Hansa Handel GmbH', eori: 'DE123456789012345' });
    await consultant.a.post(`/api/v1/clients/${client.id}/importers`, { name: 'Rotterdam Metals BV', eori: 'NL987654321' });
    const detail = await consultant.a.get(`/api/v1/clients/${client.id}`);
    expect(detail.body.installations).toHaveLength(2);
    expect(detail.body.importers.map((i: { eori: string }) => i.eori).sort()).toEqual(['DE123456789012345', 'NL987654321']);
    const list = await consultant.a.get('/api/v1/clients');
    expect(list.body.clients.find((c: { id: string }) => c.id === client.id).installationCount).toBe(2);
  });
});

describe('M2-R2 template fields', () => {
  it('stores every sheet A field and returns it unchanged', async () => {
    const client = await newClient(consultant.a);
    const full = installationBody({
      nameLocal: 'जामनगर स्मेल्टर',
      economicActivity: 'Primary aluminium production',
      postcode: '361004',
      poBox: 'PO 18',
      authRepName: 'Anita Rao',
      authRepEmail: 'anita@aurum.example',
      authRepPhone: '+91 288 255 0000',
      permitNo: 'GPCB/CCA/2024/118',
    });
    const res = await consultant.a.post(`/api/v1/clients/${client.id}/installations`, full);
    const { id, clientId, updatedAt, ...stored } = res.body.installation;
    expect({ id, clientId, updatedAt }).toMatchObject({ clientId: client.id });
    expect(stored).toEqual(full);
  });
});

describe('M2-R3 country as ISO code', () => {
  it('AT1: two installations in different countries each keep their own country', async () => {
    const client = await newClient(consultant.a);
    const india = await newInstallation(consultant.a, client.id);
    const turkey = await newInstallation(consultant.a, client.id, { countryCode: 'TR', unLocode: 'TRIZM', city: 'Izmir' });
    expect(india.countryCode).toBe('IN');
    expect(turkey.countryCode).toBe('TR');
    // Grid-factor and carbon-price defaults by country arrive with M4/M9 (M2-R3 partial).
  });

  it('refuses a country that is not in the template list', async () => {
    const res = await consultant.a.post('/api/v1/clients', clientBody({ countryCode: 'QQ' }));
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: ['countryCode'], message: 'Choose a country from the list.' }]);
  });

  it('lists countries with the template’s names', async () => {
    const res = await consultant.a.get('/api/v1/reference/countries');
    expect(res.body.countries).toContainEqual({ code: 'TR', name: 'Türkiye' });
    expect(res.body.countries.length).toBe(266);
  });
});

describe('M2-R4 validation in the API', () => {
  let clientId: string;
  beforeAll(async () => {
    clientId = (await newClient(consultant.a)).id;
  });

  it('AT2: latitude 95 is rejected by the API', async () => {
    const res = await consultant.a.post(`/api/v1/clients/${clientId}/installations`, installationBody({ latitude: '95' }));
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0]).toEqual({ path: ['latitude'], message: 'Latitude must be between −90 and 90.' });
  });

  it('checks cross-field rules on partial updates against the whole record', async () => {
    const inst = await newInstallation(consultant.a, clientId);
    // Changing only the country would leave UN/LOCODE INJGA pointing at India.
    const res = await consultant.a.patch(`/api/v1/installations/${inst.id}`, { countryCode: 'TR' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].path).toEqual(['unLocode']);
    const ok = await consultant.a.patch(`/api/v1/installations/${inst.id}`, { countryCode: 'TR', unLocode: 'TRIZM' });
    expect(ok.status).toBe(200);
  });

  it('rejects a malformed EORI and email', async () => {
    expect((await consultant.a.post(`/api/v1/clients/${clientId}/importers`, { name: 'X', eori: '12345' })).status).toBe(400);
    expect((await consultant.a.post('/api/v1/clients', clientBody({ contactEmail: 'nope' }))).status).toBe(400);
  });

  it('the database holds the same rules if the API is bypassed', async () => {
    await expect(
      withContext(t.db, { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin', requestId: randomUUID() }, (tx) =>
        tx.insertInto('installation')
          .values({ tenant_id: admin.tenantId, client_id: clientId, name_en: 'Bypass', street: 's', city: 'c', country_code: 'IN', latitude: '95', longitude: '0' })
          .execute(),
      ),
    ).rejects.toThrow(/installation_latitude_check/);
  });
});

describe('M2-R5 duplicates', () => {
  it('blocks the same legal name in the same country, case-insensitively', async () => {
    const c = await newClient(consultant.a);
    const dup = await consultant.a.post('/api/v1/clients', clientBody({ legalName: c.legalName.toUpperCase() }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('A client with this legal name already exists in this country.');
    expect((await consultant.a.post('/api/v1/clients', clientBody({ legalName: c.legalName, countryCode: 'TR' }))).status).toBe(201);
  });

  it('blocks the same installation name within a client, not across clients', async () => {
    const a = await newClient(consultant.a);
    const b = await newClient(consultant.a);
    await newInstallation(consultant.a, a.id, { nameEn: 'Anode plant' });
    expect((await consultant.a.post(`/api/v1/clients/${a.id}/installations`, installationBody({ nameEn: 'anode PLANT' }))).status).toBe(409);
    expect((await consultant.a.post(`/api/v1/clients/${b.id}/installations`, installationBody({ nameEn: 'Anode plant' }))).status).toBe(201);
  });

  it('frees the name once the earlier record is deleted', async () => {
    const c = await newClient(consultant.a);
    const i = await newInstallation(consultant.a, c.id, { nameEn: 'Casthouse' });
    await consultant.a.raw.delete(`/api/v1/installations/${i.id}`).set('Origin', 'http://localhost:5173');
    expect((await consultant.a.post(`/api/v1/clients/${c.id}/installations`, installationBody({ nameEn: 'Casthouse' }))).status).toBe(201);
  });
});

describe('M2-R6 soft delete', () => {
  const del = (a: TestAgent, url: string) => a.raw.delete(url).set('Origin', 'http://localhost:5173');

  it('a client with installations cannot be deleted; its installations go first', async () => {
    const c = await newClient(consultant.a);
    const i = await newInstallation(consultant.a, c.id);
    const blocked = await del(consultant.a, `/api/v1/clients/${c.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe('Delete this client’s 1 installation(s) first.');
    expect((await del(consultant.a, `/api/v1/installations/${i.id}`)).status).toBe(204);
    expect((await del(consultant.a, `/api/v1/clients/${c.id}`)).status).toBe(204);
    expect((await consultant.a.get(`/api/v1/clients/${c.id}`)).status).toBe(404);
  });

  it('keeps the row and its history in the database', async () => {
    const c = await newClient(consultant.a);
    await del(consultant.a, `/api/v1/clients/${c.id}`);
    const { rows } = await sql<{ deleted: boolean; actions: string[] }>`
      select c.deleted_at is not null as deleted,
             (select array_agg(action order by id) from audit.audit_log where record_id = c.id::text) as actions
        from client c where c.id = ${c.id}`.execute(t.su);
    expect(rows[0]).toEqual({ deleted: true, actions: ['Add client', 'Delete client'] });
  });

  it('the app role has no hard delete on registry tables', async () => {
    const c = await newClient(consultant.a);
    await expect(
      withContext(t.db, { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin', requestId: randomUUID() }, (tx) =>
        tx.deleteFrom('client').where('id', '=', c.id).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('M2-R7 tenant and client ids, audit', () => {
  it('audit entries for installations carry tenant and client', async () => {
    const c = await newClient(consultant.a);
    const i = await newInstallation(consultant.a, c.id);
    await consultant.a.patch(`/api/v1/installations/${i.id}`, { city: 'Jamnagar Rural' });
    const { rows } = await sql<{ action: string; tenant_id: string; client_id: string; changed_fields: string[] | null }>`
      select action, tenant_id, client_id, changed_fields from audit.audit_log where record_id = ${i.id} order by id`.execute(t.su);
    expect(rows).toEqual([
      { action: 'Add installation', tenant_id: admin.tenantId, client_id: c.id, changed_fields: null },
      { action: 'Edit installation', tenant_id: admin.tenantId, client_id: c.id, changed_fields: ['city'] },
    ]);
  });

  it('an installation cannot be moved to another client', async () => {
    const a = await newClient(consultant.a);
    const b = await newClient(consultant.a);
    const i = await newInstallation(consultant.a, a.id);
    await expect(
      withContext(t.db, { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin', requestId: randomUUID() }, (tx) =>
        tx.updateTable('installation').set({ client_id: b.id }).where('id', '=', i.id).execute(),
      ),
    ).rejects.toThrow(/cannot be moved to another client/);
  });
});

describe('access by assignment (G1, G2, decision D4; M1-R2, M1-R3)', () => {
  let clientId: string;
  let x: string;
  let y: string;
  let contributor: { a: TestAgent; id: string };
  let reviewer: { a: TestAgent; id: string };

  beforeAll(async () => {
    clientId = (await newClient(consultant.a)).id;
    x = (await newInstallation(consultant.a, clientId, { nameEn: 'Installation X' })).id;
    y = (await newInstallation(consultant.a, clientId, { nameEn: 'Installation Y' })).id;
    const c = await inviteAndAccept(t, consultant.a, 'contributor', 'Pat Plant');
    const r = await inviteAndAccept(t, consultant.a, 'reviewer', 'Rhea Reviewer');
    expect((await consultant.a.raw.put(`/api/v1/installations/${x}/team/${c.id}`).set('Origin', 'http://localhost:5173')).status).toBe(204);
    expect((await consultant.a.raw.put(`/api/v1/clients/${clientId}/team/${r.id}`).set('Origin', 'http://localhost:5173')).status).toBe(204);
    contributor = { a: (await signIn(t, c.email)).a, id: c.id };
    reviewer = { a: (await signIn(t, r.email)).a, id: r.id };
  });

  it('M1 AT1: contributor on X requesting Y by direct URL is denied', async () => {
    expect((await contributor.a.get(`/api/v1/installations/${x}`)).status).toBe(200);
    const res = await contributor.a.get(`/api/v1/installations/${y}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Installation Y');
  });

  it('a contributor sees only their installation in the client and cannot edit it', async () => {
    const detail = await contributor.a.get(`/api/v1/clients/${clientId}`);
    expect(detail.body.installations.map((i: { id: string }) => i.id)).toEqual([x]);
    expect((await contributor.a.patch(`/api/v1/installations/${x}`, { city: 'Elsewhere' })).status).toBe(403);
  });

  it('a reviewer assigned to the client reads all its installations but cannot write', async () => {
    const detail = await reviewer.a.get(`/api/v1/clients/${clientId}`);
    expect(detail.body.installations).toHaveLength(2);
    expect((await reviewer.a.post(`/api/v1/clients/${clientId}/installations`, installationBody())).status).toBe(403);
  });

  it('M1 AT2: a recipient cannot create data', async () => {
    const r = await inviteAndAccept(t, consultant.a, 'recipient');
    const { a } = await signIn(t, r.email);
    expect((await a.post('/api/v1/clients', clientBody())).status).toBe(403);
  });

  it('another consultant does not see this consultant’s client', async () => {
    const other = await inviteAndAccept(t, admin.a, 'consultant');
    const { a } = await signInWithMfa(t, other.email);
    expect((await a.get(`/api/v1/clients/${clientId}`)).status).toBe(404);
    expect((await a.get('/api/v1/clients')).body.clients).toEqual([]);
    expect((await a.patch(`/api/v1/installations/${x}`, { city: 'Hijack' })).status).toBe(404);
  });

  it('the admin sees every client in the tenant', async () => {
    const list = await admin.a.get('/api/v1/clients');
    expect(list.body.clients.map((c: { id: string }) => c.id)).toContain(clientId);
  });

  it('the team lists client- and installation-level assignments', async () => {
    const team = await consultant.a.get(`/api/v1/clients/${clientId}/team`);
    const byUser = Object.fromEntries(team.body.team.map((m: { userId: string; installationId: string | null }) => [m.userId, m.installationId]));
    expect(byUser).toMatchObject({ [consultant.id]: null, [reviewer.id]: null, [contributor.id]: x });
  });

  it('contributors are assigned to installations, other roles to clients', async () => {
    const put = (url: string) => consultant.a.raw.put(url).set('Origin', 'http://localhost:5173');
    expect((await put(`/api/v1/clients/${clientId}/team/${contributor.id}`)).status).toBe(400);
    expect((await put(`/api/v1/installations/${y}/team/${reviewer.id}`)).status).toBe(400);
  });

  it('removing an assignment removes access at once', async () => {
    const put = (url: string) => consultant.a.raw.put(url).set('Origin', 'http://localhost:5173');
    const del = (url: string) => consultant.a.raw.delete(url).set('Origin', 'http://localhost:5173');
    expect((await put(`/api/v1/installations/${y}/team/${contributor.id}`)).status).toBe(204);
    expect((await contributor.a.get(`/api/v1/installations/${y}`)).status).toBe(200);
    expect((await del(`/api/v1/installations/${y}/team/${contributor.id}`)).status).toBe(204);
    expect((await contributor.a.get(`/api/v1/installations/${y}`)).status).toBe(404);
  });

  it('a consultant cannot assign another consultant (database refuses too)', async () => {
    const other = await inviteAndAccept(t, admin.a, 'consultant');
    await expect(
      withContext(t.db, { tenantId: admin.tenantId, userId: consultant.id, userRole: 'consultant', requestId: randomUUID() }, (tx) =>
        tx.insertInto('user_client_assignment').values({ tenant_id: admin.tenantId, user_id: other.id, client_id: clientId }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a consultant cannot add an installation to a client they are not on (database refuses too)', async () => {
    const foreign = await newClient(admin.a);
    await expect(
      withContext(t.db, { tenantId: admin.tenantId, userId: consultant.id, userRole: 'consultant', requestId: randomUUID() }, (tx) =>
        tx.insertInto('installation')
          .values({ tenant_id: admin.tenantId, client_id: foreign.id, name_en: 'Sneaky', street: 's', city: 'c', country_code: 'IN' })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('users on a shared client become visible to the consultant', async () => {
    const list = await consultant.a.get('/api/v1/users');
    const ids = list.body.users.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([contributor.id, reviewer.id]));
  });
});

describe('G1 across tenants', () => {
  it('another tenant sees none of these records', async () => {
    const c = await newClient(consultant.a);
    const i = await newInstallation(consultant.a, c.id);
    const other = await adminOfNewTenant(t);
    expect((await other.a.get(`/api/v1/clients/${c.id}`)).status).toBe(404);
    expect((await other.a.get(`/api/v1/installations/${i.id}`)).status).toBe(404);
    expect((await other.a.get('/api/v1/clients')).body.clients).toEqual([]);
    expect((await other.a.post(`/api/v1/clients/${c.id}/installations`, installationBody())).status).toBe(404);
  });
});

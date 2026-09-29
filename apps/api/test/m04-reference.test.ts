import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../src/platform/db';
import { type TestAgent, WEB_ORIGIN, adminOfNewTenant, inviteAndAccept, signIn, signInWithMfa, testApp } from './helpers';

// M4 — Reference library. Requirement IDs from
// .claude/skills/cbam-module-reviewer/references/modules/M04-reference-library.md
// The library is platform-wide, so tests in this file run in order and leave no open draft.

const t = testApp();
let admin: Awaited<ReturnType<typeof adminOfNewTenant>>;
let consultant: { a: TestAgent; id: string; email: string };
let contributor: { a: TestAgent; id: string };

const del = (a: TestAgent, url: string) => a.raw.delete(url).set('Origin', WEB_ORIGIN);
const put = (a: TestAgent, url: string, body: object) => a.raw.put(url).set('Origin', WEB_ORIGIN).send(body);

const FACTOR_HEADER = 'kind,subject,country_code,region,year,component,value,unit,valid_from,valid_to,plausible_min,plausible_max,source,notes';

async function current() {
  const res = await admin.a.get('/api/v1/library/versions/current');
  expect(res.status).toBe(200);
  return res.body.version as { id: string; code: string };
}

async function newDraft(code = `t-${randomUUID().slice(0, 8)}`) {
  const res = await admin.a.post('/api/v1/library/versions', { code, notes: 'Test draft' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.version as { id: string; code: string; status: string };
}

async function reviewed(versionId: string) {
  const res = await admin.a.get(`/api/v1/library/versions/${versionId}/diff`);
  expect(res.status).toBe(200);
  return res.body.fingerprint as string;
}

async function publish(v: { id: string; code: string }) {
  const res = await admin.a.post(`/api/v1/library/versions/${v.id}/publish`, { confirmCode: v.code, diffFingerprint: await reviewed(v.id) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function factors(versionId: string, kind?: string) {
  const res = await admin.a.get(`/api/v1/library/versions/${versionId}/factors${kind ? `?kind=${kind}` : ''}`);
  expect(res.status).toBe(200);
  return res.body.factors as { id: string; kind: string; subject: string; value: string; unit: string }[];
}

const natGas = (fs: Awaited<ReturnType<typeof factors>>) => fs.find((f) => f.kind === 'emission_factor' && f.subject === 'Natural gas')!;

beforeAll(async () => {
  admin = await adminOfNewTenant(t);
  // Decision D12: only the operator tenant's admins maintain the shared library.
  await sql`select auth.set_platform_operator(${admin.slug})`.execute(t.owner);
  const c = await inviteAndAccept(t, admin.a, 'consultant', 'Cara Consultant');
  consultant = { ...(await signInWithMfa(t, c.email)), ...c };
  const k = await inviteAndAccept(t, admin.a, 'contributor', 'Dev Contributor');
  const { a } = await signIn(t, k.email);
  contributor = { a, id: k.id };
});

// Discard whatever draft a failing test left open, so the next test can start one.
afterEach(async () => {
  const res = await admin.a.get('/api/v1/library/versions');
  for (const v of res.body.versions.filter((x: { status: string }) => x.status === 'draft')) {
    await del(admin.a, `/api/v1/library/versions/${v.id}`);
  }
});

afterAll(() => t.close());

describe('seed from template 2026-Q2', () => {
  it('publishes 2026.1 with the template’s goods, routes, CN codes, GWPs and natural gas EF', async () => {
    const list = await admin.a.get('/api/v1/library/versions');
    const seed = list.body.versions.find((v: { code: string }) => v.code === '2026.1');
    expect(seed).toMatchObject({ status: 'published', counts: { cnCodes: 569, goodsCategories: 18, factors: 4 } });

    const gwps = await factors(seed.id, 'gwp');
    expect(gwps.map((g) => [g.subject, g.value, g.unit])).toEqual([
      ['C2F6', '11100', 'tCO2e/tGHG'],
      ['CF4', '6630', 'tCO2e/tGHG'],
      ['N2O', '265', 'tCO2e/tGHG'],
    ]);
    expect(natGas(await factors(seed.id))).toMatchObject({ value: '56.1', unit: 'tCO2/TJ' });
  });

  it('lists template 2026-Q2 with its file hash', async () => {
    const res = await contributor.a.get('/api/v1/library/templates');
    expect(res.body.templates).toContainEqual(
      expect.objectContaining({ code: '2026-Q2', fileSha256: '5a4e28fdbccfdca45a2c0520184b551a20c0c7bba3db79f87d78c9e58a6c0917' }),
    );
  });
});

describe('M4-R1 factor fields, M4-R8 range bands', () => {
  it('stores value, unit, SI value, source, validity, version and range', async () => {
    const draft = await newDraft();
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
      kind: 'ncv',
      subject: 'Coking coal',
      value: '28.2',
      unit: 'GJ/t',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      plausibleMin: '25',
      plausibleMax: '32',
      source: 'IPCC 2006 Guidelines, Vol. 2, Table 1.2',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.factor).toMatchObject({
      value: '28.2',
      unit: 'GJ/t',
      valueSi: '0.0282',
      siUnit: 'TJ/t',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      plausibleMin: '25',
      plausibleMax: '32',
      source: 'IPCC 2006 Guidelines, Vol. 2, Table 1.2',
    });
    const bad = await admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
      kind: 'ncv', subject: 'Coke', value: '28', unit: 'GJ/t', validFrom: '2026-01-01', plausibleMin: '32', plausibleMax: '25', source: 'x',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.issues).toEqual([{ path: ['plausibleMax'], message: 'The upper bound must be at least the lower bound.' }]);
  });

  it('refuses a factor without a source or with a unit of the wrong kind', async () => {
    const draft = await newDraft();
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
      kind: 'grid_factor', subject: 'electricity', countryCode: 'IN', year: 2026, value: '0.7', unit: 'tCO2/TJ', validFrom: '2026-01-01', source: '',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.issues.map((i: { path: string[] }) => i.path[0]).sort()).toEqual(['source', 'unit']);
  });
});

describe('M4-R2 published versions are immutable', () => {
  it('refuses edits to a published version through the API', async () => {
    const seed = await current();
    const gas = natGas(await factors(seed.id));
    const patch = await admin.a.patch(`/api/v1/library/factors/${gas.id}`, { value: '99' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('library_published');
    expect((await del(admin.a, `/api/v1/library/factors/${gas.id}`)).status).toBe(409);
    expect((await del(admin.a, `/api/v1/library/versions/${seed.id}`)).status).toBe(409);
  });

  it('refuses edits to a published version in the database, even for the admin role', async () => {
    const seed = await current();
    const ctx = { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin' as const, requestId: 'test' };
    await expect(
      withContext(t.db, ctx, (tx) => tx.updateTable('library_factor').set({ value: '1' }).where('library_version_id', '=', seed.id).execute()),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      withContext(t.db, ctx, (tx) => tx.updateTable('library_version').set({ notes: 'edited' }).where('id', '=', seed.id).execute()),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      withContext(t.db, ctx, (tx) =>
        tx.insertInto('cn_code').values({ library_version_id: seed.id, code: '99999999', description: 'x', goods_category_code: 'cement' }).execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('F1: refuses to publish when the draft changed after the diff was reviewed', async () => {
    const draft = await newDraft();
    const fingerprint = await reviewed(draft.id);
    await admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
      kind: 'ncv', subject: 'Diesel', value: '43', unit: 'GJ/t', validFrom: '2026-01-01', source: 'IPCC',
    });
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/publish`, { confirmCode: draft.code, diffFingerprint: fingerprint });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('stale_diff');
  });

  it('F1: an edit that started before publish cannot land in the published version', async () => {
    const draft = await newDraft();
    const gas = natGas(await factors(draft.id));
    const fingerprint = await reviewed(draft.id);
    const ctx = { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin' as const, requestId: 'test' };
    // A direct write holds its transaction open while publish runs.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const edit = withContext(t.db, ctx, async (tx) => {
      await tx.updateTable('library_factor').set({ value: '77', value_si: '77' }).where('id', '=', gas.id).execute();
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    const publishing = admin.a.post(`/api/v1/library/versions/${draft.id}/publish`, { confirmCode: draft.code, diffFingerprint: fingerprint });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await edit;
    const res = await publishing;
    // Publish waited for the edit, then saw a different draft than the one reviewed.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('stale_diff');
  });

  it('F7: two drafts created at once give one draft and one 409', async () => {
    const [a, b] = await Promise.all([
      admin.a.post('/api/v1/library/versions', { code: `t-${randomUUID().slice(0, 8)}` }),
      admin.a.post('/api/v1/library/versions', { code: `t-${randomUUID().slice(0, 8)}` }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('allows only one draft at a time', async () => {
    await newDraft();
    const second = await admin.a.post('/api/v1/library/versions', { code: `t-${randomUUID().slice(0, 8)}` });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('draft_exists');
  });
});

describe('M4-R3 versions are pinned, AT1', () => {
  it('AT1: publishing a new natural gas EF leaves the old version (and whatever pinned it) unchanged', async () => {
    const old = await current();
    const draft = await newDraft();
    const gas = natGas(await factors(draft.id));
    expect((await admin.a.patch(`/api/v1/library/factors/${gas.id}`, { value: '56.4', source: 'Updated national inventory 2026' })).status).toBe(200);

    const diff = await admin.a.get(`/api/v1/library/versions/${draft.id}/diff`);
    expect(diff.body.diff.factors.changed).toEqual([
      expect.objectContaining({ label: 'Emission factor: Natural gas', fields: ['source', 'value', 'valueSi'] }),
    ]);
    expect(diff.body.diff.cn_codes).toBeUndefined();

    await publish(draft);
    expect((await current()).id).toBe(draft.id);
    expect(natGas(await factors(draft.id)).value).toBe('56.4');
    // A period or result pinned to the old version id still reads 56.1 (G9). The period and
    // report parts of AT1 are re-run when M3 and M12 exist.
    expect(natGas(await factors(old.id)).value).toBe('56.1');
  });

  it('asks for the version code to confirm publishing', async () => {
    const draft = await newDraft();
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/publish`, { confirmCode: 'wrong', diffFingerprint: await reviewed(draft.id) });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: ['confirmCode'], message: `Type ${draft.code} to confirm.` }]);
  });
});

describe('M4-R4 import with diff preview, AT2', () => {
  it('AT2: a file with a malformed row is rejected whole, with the row number', async () => {
    const draft = await newDraft();
    const before = await factors(draft.id);
    const content = [FACTOR_HEADER, 'ncv,Natural gas,,,,,48,GJ/t,2026-01-01,,44,50,IPCC,', 'ncv,Fuel oil,,,,,40..4,GJ/t,2026-01-01,,,,IPCC,'].join('\n');
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, { dataset: 'factors', fileName: 'ncv.csv', content });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('import_rejected');
    expect(res.body.error.message).toBe('The file was not imported: line 3 has an error. Fix it and upload the file again.');
    expect(res.body.error.details.errors).toEqual([
      { row: 3, column: 'value', message: 'Enter a number, using a dot as the decimal separator.' },
    ]);
    expect(await factors(draft.id)).toEqual(before);
    const { rows } = await sql<{ n: string }>`select count(*) as n from library_import where library_version_id = ${draft.id}`.execute(t.su);
    expect(rows[0]!.n).toBe('0');
  });

  it('rejects unknown countries and goods categories with row numbers', async () => {
    const draft = await newDraft();
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, {
      dataset: 'cn_codes',
      fileName: 'cn.csv',
      content: 'cn_code,description,goods_category\n72081000,Flat-rolled,iron_steel_products\n76011000,Aluminium,unobtainium\n',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors).toEqual([
      { row: 3, column: 'goods_category', message: '"unobtainium" is not a goods category code in this version.' },
    ]);
  });

  it('previews added, changed and removed factors for the kinds in the file, then applies them', async () => {
    const draft = await newDraft();
    const content = [
      FACTOR_HEADER,
      'grid_factor,electricity,IN,,2026,,0.716,tCO2/MWh,2026-01-01,2026-12-31,0.5,0.9,CEA CO2 Baseline Database v20,',
      'grid_factor,electricity,TR,,2026,,0.44,tCO2/MWh,2026-01-01,2026-12-31,,,Turkish grid factor 2026,',
      'gwp,N2O,,,,,265,tCO2e/tGHG,2026-01-01,,,,"CBAM Communication Template 2026-Q2, Parameters_Constants (CONST_GWP_N2O)",',
      'gwp,CF4,,,,,7390,tCO2e/tGHG,2026-01-01,,,,IPCC AR4,',
    ].join('\n');
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, { dataset: 'factors', fileName: 'grid.csv', content });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { diff, id, rowCount } = res.body.preview;
    expect(rowCount).toBe(4);
    expect(diff.added.map((r: { label: string }) => r.label)).toEqual(['Grid emission factor: electricity, IN, 2026', 'Grid emission factor: electricity, TR, 2026']);
    expect(diff.changed.map((r: { label: string; fields: string[] }) => [r.label, r.fields])).toEqual([
      ['Global warming potential: CF4', ['source', 'value', 'valueSi']],
    ]);
    // C2F6 is a GWP not in the file, so it would be removed; emission factors are untouched.
    expect(diff.removed.map((r: { label: string }) => r.label)).toEqual(['Global warming potential: C2F6']);

    // Nothing changes until the preview is applied.
    expect((await factors(draft.id, 'grid_factor')).length).toBe(0);
    const apply = await admin.a.post(`/api/v1/library/imports/${id}/apply`);
    expect(apply.status, JSON.stringify(apply.body)).toBe(200);
    const grid = await factors(draft.id, 'grid_factor');
    expect(grid.map((g) => [g.subject, g.value])).toEqual([['electricity', '0.716'], ['electricity', '0.44']]);
    expect((await factors(draft.id, 'gwp')).map((g) => g.subject).sort()).toEqual(['CF4', 'N2O']);
    expect(natGas(await factors(draft.id))).toBeDefined();
    expect((await admin.a.post(`/api/v1/library/imports/${id}/apply`)).status).toBe(409);
  });

  it('refuses to apply a preview after the draft changed', async () => {
    const draft = await newDraft();
    const content = [FACTOR_HEADER, 'ncv,Diesel,,,,,43,GJ/t,2026-01-01,,,,IPCC,'].join('\n');
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, { dataset: 'factors', fileName: 'ncv.csv', content });
    await admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
      kind: 'ncv', subject: 'Petrol', value: '44.3', unit: 'GJ/t', validFrom: '2026-01-01', source: 'IPCC',
    });
    const apply = await admin.a.post(`/api/v1/library/imports/${res.body.preview.id}/apply`);
    expect(apply.status).toBe(409);
    expect(apply.body.error.code).toBe('stale_preview');
  });

  it('F5: two previews applied at once — the second is refused as stale', async () => {
    const draft = await newDraft();
    const up = (subject: string) =>
      admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, {
        dataset: 'factors', fileName: 'ncv.csv', content: `${FACTOR_HEADER}\nncv,${subject},,,,,43,GJ/t,2026-01-01,,,,IPCC,`,
      });
    const [p1, p2] = [await up('Diesel'), await up('Petrol')];
    const results = await Promise.all([p1, p2].map((p) => admin.a.post(`/api/v1/library/imports/${p.body.preview.id}/apply`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await factors(draft.id, 'ncv')).length).toBe(1);
  });

  it('replaces CN codes from a file', async () => {
    const draft = await newDraft();
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, {
      dataset: 'cn_codes',
      fileName: 'cn.csv',
      content: 'cn_code,description,goods_category\n"7601 10 10","Aluminium slabs, not alloyed",unwrought_aluminium\n',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.preview.diff.removed.length).toBe(568);
    expect(res.body.preview.diff.changed.map((c: { key: string; fields: string[] }) => [c.key, c.fields])).toEqual([['76011010', ['description']]]);
    await admin.a.post(`/api/v1/library/imports/${res.body.preview.id}/apply`);
    const cn = await admin.a.get(`/api/v1/library/versions/${draft.id}/cn-codes`);
    expect(cn.body.cnCodes).toEqual([{ code: '76011010', description: 'Aluminium slabs, not alloyed', goodsCategoryCode: 'unwrought_aluminium' }]);
  });
});

describe('M4-R5 who may publish, AT3', () => {
  it('AT3: a consultant cannot create, edit or publish a library version', async () => {
    expect((await consultant.a.post('/api/v1/library/versions', { code: 'c-1' })).status).toBe(403);
    const draft = await newDraft();
    expect((await consultant.a.post(`/api/v1/library/versions/${draft.id}/publish`, { confirmCode: draft.code, diffFingerprint: 'a'.repeat(64) })).status).toBe(403);
    expect(
      (await consultant.a.post(`/api/v1/library/versions/${draft.id}/factors`, { kind: 'ncv', subject: 'X', value: '1', unit: 'GJ/t', validFrom: '2026-01-01', source: 'x' })).status,
    ).toBe(403);
    expect((await consultant.a.post(`/api/v1/library/versions/${draft.id}/imports`, { dataset: 'cn_codes', fileName: 'a.csv', content: 'x' })).status).toBe(403);
  });

  it('AT3: the database refuses a consultant too (G2)', async () => {
    const draft = await newDraft();
    const ctx = { tenantId: admin.tenantId, userId: consultant.id, userRole: 'consultant' as const, requestId: 'test' };
    const r = await withContext(t.db, ctx, (tx) => tx.updateTable('library_version').set({ status: 'published' }).where('id', '=', draft.id).executeTakeFirst());
    expect(Number(r.numUpdatedRows)).toBe(0); // RLS hides the row from writes
    await expect(
      withContext(t.db, ctx, (tx) => tx.insertInto('library_version').values({ code: `c-${randomUUID().slice(0, 6)}` }).execute()),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('F2: the admin of another tenant cannot change the shared library', async () => {
    const other = await adminOfNewTenant(t);
    const list = await other.a.get('/api/v1/library/versions');
    expect(list.status).toBe(200);
    expect(list.body.canEdit).toBe(false);
    expect((await admin.a.get('/api/v1/library/versions')).body.canEdit).toBe(true);
    const res = await other.a.post('/api/v1/library/versions', { code: `x-${randomUUID().slice(0, 6)}` });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only platform admins of the platform operator can change the reference library.');

    const draft = await newDraft();
    expect((await other.a.post(`/api/v1/library/versions/${draft.id}/publish`, { confirmCode: draft.code, diffFingerprint: await reviewed(draft.id) })).status).toBe(403);
    const ctx = { tenantId: other.tenantId, userId: other.adminId, userRole: 'platform_admin' as const, requestId: 'test' };
    await expect(
      withContext(t.db, ctx, (tx) => tx.insertInto('library_version').values({ code: `x-${randomUUID().slice(0, 6)}` }).execute()),
    ).rejects.toMatchObject({ code: '42501' });
    const r = await withContext(t.db, ctx, (tx) => tx.updateTable('library_version').set({ status: 'published' }).where('id', '=', draft.id).executeTakeFirst());
    expect(Number(r.numUpdatedRows)).toBe(0);
  });

  it('F2: the app role cannot make its tenant the operator; the owner CLI function can, and it is audited', async () => {
    const other = await adminOfNewTenant(t);
    const ctx = { tenantId: other.tenantId, userId: other.adminId, userRole: 'platform_admin' as const, requestId: 'test' };
    await expect(withContext(t.db, ctx, (tx) => sql`select auth.set_platform_operator(${other.slug})`.execute(tx))).rejects.toMatchObject({ code: '42501' });
    await expect(
      withContext(t.db, ctx, (tx) => sql`update tenant set is_platform_operator = true where id = ${other.tenantId}`.execute(tx)),
    ).rejects.toMatchObject({ code: '42501' });

    // Move the role and back; exactly one operator at a time.
    await sql`select auth.set_platform_operator(${other.slug})`.execute(t.owner);
    const { rows } = await sql<{ slug: string }>`select slug from tenant where is_platform_operator`.execute(t.su);
    expect(rows).toEqual([{ slug: other.slug }]);
    expect((await admin.a.get('/api/v1/library/versions')).body.canEdit).toBe(false);
    await sql`select auth.set_platform_operator(${admin.slug})`.execute(t.owner);
    const audit = await sql<{ action: string; changed_fields: string[] }>`
      select action, changed_fields from audit.audit_log where table_name = 'public.tenant' and record_id = ${other.tenantId} and op = 'UPDATE' order by id`.execute(t.su);
    expect(audit.rows).toEqual([
      { action: 'Set platform operator', changed_fields: ['is_platform_operator'] },
      { action: 'Set platform operator', changed_fields: ['is_platform_operator'] },
    ]);
  });

  it('every role can read the library', async () => {
    const res = await contributor.a.get('/api/v1/library/versions');
    expect(res.status).toBe(200);
    expect(res.body.versions.length).toBeGreaterThan(0);
  });
});

describe('M4-R5 client-specific overrides', () => {
  let clientId: string;
  beforeAll(async () => {
    const res = await consultant.a.post('/api/v1/clients', {
      legalName: `Aurum Metals ${randomUUID().slice(0, 6)}`,
      addressLine1: '12 Marine Drive',
      city: 'Mumbai',
      countryCode: 'IN',
      contactName: 'Ravi Mehta',
      contactEmail: 'ravi@aurum.example',
    });
    clientId = res.body.client.id;
  });

  const body = (over: Record<string, unknown> = {}) => ({
    kind: 'emission_factor',
    subject: 'Natural gas',
    value: '55.8',
    unit: 'tCO2/TJ',
    validFrom: '2026-01-01',
    source: 'Supplier gas analysis 2026-03, lab report 118',
    justification: 'Plant-specific gas composition measured monthly.',
    ...over,
  });

  it('a consultant proposes an override; it is flagged and shown next to the library value', async () => {
    const res = await consultant.a.post(`/api/v1/clients/${clientId}/factor-overrides`, body());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const current = await (await admin.a.get('/api/v1/library/versions/current')).body.version;
    expect(res.body.override).toMatchObject({
      status: 'proposed',
      value: '55.8',
      valueSi: '55.8',
      proposedBy: consultant.id,
      proposedByName: 'Cara Consultant',
      libraryValue: { unit: 'tCO2/TJ', versionCode: current.code },
    });
    const dup = await consultant.a.post(`/api/v1/clients/${clientId}/factor-overrides`, body({ value: '55.9' }));
    expect(dup.status).toBe(409);
  });

  it('only the platform admin approves or rejects', async () => {
    const list = await consultant.a.get(`/api/v1/clients/${clientId}/factor-overrides`);
    const o = list.body.overrides.find((x: { status: string }) => x.status === 'proposed');
    expect((await consultant.a.post(`/api/v1/factor-overrides/${o.id}/approve`)).status).toBe(403);
    const ctx = { tenantId: admin.tenantId, userId: consultant.id, userRole: 'consultant' as const, requestId: 'test' };
    await expect(
      withContext(t.db, ctx, (tx) => tx.updateTable('client_factor_override').set({ status: 'approved' }).where('id', '=', o.id).execute()),
    ).rejects.toMatchObject({ code: '42501' });

    const ok = await admin.a.post(`/api/v1/factor-overrides/${o.id}/approve`, { note: 'Lab report checked.' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.override).toMatchObject({ status: 'approved', decidedByName: 'Ada Admin', decisionNote: 'Lab report checked.' });
    expect((await admin.a.post(`/api/v1/factor-overrides/${o.id}/reject`, { note: 'x' })).status).toBe(409);
  });

  it('values never change after the proposal; the proposer withdraws instead', async () => {
    const list = await consultant.a.get(`/api/v1/clients/${clientId}/factor-overrides`);
    const o = list.body.overrides[0];
    const ctx = { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin' as const, requestId: 'test' };
    await expect(
      withContext(t.db, ctx, (tx) => tx.updateTable('client_factor_override').set({ value: '1' }).where('id', '=', o.id).execute()),
    ).rejects.toMatchObject({ code: '55000' });
    const w = await consultant.a.post(`/api/v1/factor-overrides/${o.id}/withdraw`);
    // Keeps its decision; the admin's name is hidden from consultants by app_user RLS (M1).
    expect(w.body.override).toMatchObject({ status: 'withdrawn', decisionNote: 'Lab report checked.', decidedByName: null });
    // A new proposal for the same key is now allowed.
    expect((await consultant.a.post(`/api/v1/clients/${clientId}/factor-overrides`, body({ value: '55.9' }))).status).toBe(201);
  });

  it('a rejection needs a reason', async () => {
    const res = await consultant.a.post(`/api/v1/clients/${clientId}/factor-overrides`, body({ subject: 'Coal', value: '95', validFrom: '2026-02-01' }));
    const bad = await admin.a.post(`/api/v1/factor-overrides/${res.body.override.id}/reject`, {});
    expect(bad.status).toBe(400);
    expect((await admin.a.post(`/api/v1/factor-overrides/${res.body.override.id}/reject`, { note: 'No evidence attached.' })).body.override.status).toBe('rejected');
  });

  it('contributors cannot propose, and unassigned consultants cannot see the client’s overrides', async () => {
    expect((await contributor.a.post(`/api/v1/clients/${clientId}/factor-overrides`, body())).status).toBe(403);
    const other = await inviteAndAccept(t, admin.a, 'consultant', 'Otto Other');
    const { a } = await signInWithMfa(t, other.email);
    expect((await a.get(`/api/v1/clients/${clientId}/factor-overrides`)).status).toBe(404);
  });
});

describe('M4-R6 grid factors by country, region and year', () => {
  it('keys grid factors by country, region and year', async () => {
    const draft = await newDraft();
    const grid = (over: Record<string, unknown>) =>
      admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
        kind: 'grid_factor', subject: 'electricity', countryCode: 'IN', year: 2026, value: '0.71', unit: 'tCO2/MWh', validFrom: '2026-01-01', source: 'CEA', ...over,
      });
    expect((await grid({})).status).toBe(201);
    expect((await grid({ region: 'Northern grid', value: '0.75' })).status).toBe(201);
    expect((await grid({ year: 2025, validFrom: '2025-01-01' })).status).toBe(201);
    const dup = await grid({ value: '0.8' });
    expect(dup.status).toBe(409);
    const noYear = await grid({ year: null, countryCode: 'TR' });
    expect(noYear.body.error.issues).toEqual([{ path: ['year'], message: 'A grid emission factor needs a year.' }]);
  });
});

describe('F3 default values for electricity', () => {
  it('accepts tCO2e/MWh for a default value', async () => {
    const draft = await newDraft();
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
      kind: 'default_see', subject: '27160000', component: 'direct', countryCode: 'TR', value: '0.5', unit: 'tCO2e/MWh', validFrom: '2026-01-01', source: 'Commission defaults',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.factor).toMatchObject({ valueSi: '0.5', siUnit: 'tCO2e/MWh' });
  });

  it('ties the unit to the CN code’s goods category, in the form, the import and overrides', async () => {
    const draft = await newDraft();
    const post = (over: Record<string, unknown>) =>
      admin.a.post(`/api/v1/library/versions/${draft.id}/factors`, {
        kind: 'default_see', component: 'direct', value: '1.9', validFrom: '2026-01-01', source: 'Commission defaults', ...over,
      });
    const steelMwh = await post({ subject: '72081000', unit: 'tCO2e/MWh' });
    expect(steelMwh.status).toBe(400);
    expect(steelMwh.body.error.issues).toEqual([{ path: ['unit'], message: 'Iron or steel products is reported per t: use tCO₂e/t or kgCO₂e/t.' }]);
    const elecT = await post({ subject: '27160000', unit: 'tCO2e/t' });
    expect(elecT.body.error.issues).toEqual([{ path: ['unit'], message: 'Electricity (export to EU) is reported per MWh: use tCO₂e/MWh.' }]);
    const unknown = await post({ subject: '12345678', unit: 'tCO2e/t' });
    expect(unknown.body.error.issues).toEqual([{ path: ['subject'], message: '12345678 is not a CN code in this library version.' }]);
    expect((await post({ subject: '72081000', unit: 'tCO2e/t' })).status).toBe(201);

    const imp = await admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, {
      dataset: 'factors',
      fileName: 'defaults.csv',
      content: `${FACTOR_HEADER}\ndefault_see,72081000,,,,direct,1.9,tCO2e/t,2026-01-01,,,,EU,\ndefault_see,72081000,,,,indirect,0.3,tCO2e/MWh,2026-01-01,,,,EU,`,
    });
    expect(imp.status).toBe(400);
    expect(imp.body.error.details.errors).toEqual([
      { row: 3, column: 'unit', message: 'Iron or steel products is reported per t: use tCO₂e/t or kgCO₂e/t.' },
    ]);
  });

  it('F20: a change to the SI value alone shows in the publish diff', async () => {
    const draft = await newDraft();
    const gas = natGas(await factors(draft.id));
    const ctx = { tenantId: admin.tenantId, userId: admin.adminId, userRole: 'platform_admin' as const, requestId: 'test' };
    await withContext(t.db, ctx, (tx) => tx.updateTable('library_factor').set({ value_si: '60' }).where('id', '=', gas.id).execute());
    const diff = (await admin.a.get(`/api/v1/library/versions/${draft.id}/diff`)).body.diff;
    expect(diff.factors.changed[0].fields).toEqual(['valueSi']);
  });
});

describe('M4-R7 regulatory rules as configuration', () => {
  it('holds indirect-emission relevance, routes and relevant precursors from the template', async () => {
    const seed = await (await admin.a.get('/api/v1/library/versions')).body.versions.find((v: { code: string }) => v.code === '2026.1');
    const res = await contributor.a.get(`/api/v1/library/versions/${seed.id}/goods`);
    const crude = res.body.goods.find((g: { code: string }) => g.code === 'crude_steel');
    expect(crude).toMatchObject({ indirectRelevantDefinitive: false, indirectRelevantTransitional: true, routeRelevant: true });
    expect(crude.routes.map((r: { code: string }) => r.code)).toEqual(['basic_oxygen_steelmaking', 'electric_arc_furnace', 'other', 'unknown']);
    expect(crude.precursors.map((p: { precursorCode: string }) => p.precursorCode)).toEqual(['alloys', 'dri', 'pig_iron']);
    const cement = res.body.goods.find((g: { code: string }) => g.code === 'cement');
    expect(cement).toMatchObject({ indirectRelevantDefinitive: true, qualifyingParameters: [{ position: 2, name: 'Clinker factor' }] });
  });

  it('the admin edits the rules in a draft; published rules stay as they were', async () => {
    const draft = await newDraft();
    const goods = (await admin.a.get(`/api/v1/library/versions/${draft.id}/goods`)).body.goods;
    const crude = goods.find((g: { code: string }) => g.code === 'crude_steel');
    expect((await admin.a.patch(`/api/v1/library/goods-categories/${crude.id}`, { indirectRelevantDefinitive: true })).status).toBe(204);
    const r = await put(admin.a, `/api/v1/library/goods-categories/${crude.id}/precursors`, {
      precursors: [
        { routeCode: null, precursorCode: 'pig_iron' },
        { routeCode: 'electric_arc_furnace', precursorCode: 'dri' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const bad = await put(admin.a, `/api/v1/library/goods-categories/${crude.id}/precursors`, {
      precursors: [{ routeCode: 'primary_smelting', precursorCode: 'crude_steel' }],
    });
    expect(bad.body.error.issues.map((i: { path: unknown[] }) => i.path.at(-1))).toEqual(['precursorCode', 'routeCode']);

    const diff = (await admin.a.get(`/api/v1/library/versions/${draft.id}/diff`)).body.diff;
    expect(diff.goods_categories.changed[0].fields).toEqual(['indirectRelevantDefinitive']);
    expect(diff.precursors.added.map((x: { key: string }) => x.key)).toEqual(['crude_steel|electric_arc_furnace|dri']);
    expect(diff.precursors.removed.map((x: { key: string }) => x.key).sort()).toEqual(['crude_steel||alloys', 'crude_steel||dri']);

    const seedCrude = (await admin.a.get(`/api/v1/library/versions/${(await current()).id}/goods`)).body.goods.find(
      (g: { code: string }) => g.code === 'crude_steel',
    );
    expect((await admin.a.patch(`/api/v1/library/goods-categories/${seedCrude.id}`, { indirectRelevantDefinitive: true })).status).toBe(409);
  });
});

describe('audit (G3)', () => {
  it('library changes are logged with the acting user’s tenant and the button verb', async () => {
    const draft = await newDraft();
    const { rows } = await sql<{ action: string; tenant_id: string; op: string }>`
      select action, tenant_id, op from audit.audit_log where record_id = ${draft.id} order by id`.execute(t.su);
    expect(rows).toEqual([{ action: 'Create draft version', tenant_id: admin.tenantId, op: 'INSERT' }]);
  });

  it('the import payload is redacted from the log', async () => {
    const draft = await newDraft();
    const res = await admin.a.post(`/api/v1/library/versions/${draft.id}/imports`, {
      dataset: 'factors', fileName: 'x.csv', content: `${FACTOR_HEADER}\nncv,Diesel,,,,,43,GJ/t,2026-01-01,,,,IPCC,`,
    });
    const { rows } = await sql<{ rows: unknown }>`
      select new_row -> 'rows' as rows from audit.audit_log where record_id = ${res.body.preview.id}`.execute(t.su);
    expect(rows[0]!.rows).toBe('[redacted]');
  });
});

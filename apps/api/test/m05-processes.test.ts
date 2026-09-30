import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProcessDetail, ProcessList, UserRole } from '@cbam/shared';
import type { ProcessDependents } from '../src/modules/m05-processes';
import { type RequestContext, withContext } from '../src/platform/db';
import { type TestAgent, WEB_ORIGIN, adminOfNewTenant, inviteAndAccept, signIn, signInWithMfa, testApp } from './helpers';

// M5 — Process and goods set-up (docs/plans/phase-2.md, D16–D23).
// Requirement IDs from .claude/skills/cbam-module-reviewer/references/modules/M05-process-goods.md

// A stand-in for M6: source streams tied to a route of the process (review M5 F6).
const streams = new Map<string, { route: string; removed: boolean }>();
const fakeM6: ProcessDependents = {
  list: async (_tx, id) => (streams.has(id) ? [{ table: 'source_stream', id, label: 'Source stream: Anode carbon' }] : []),
  remove: async (_tx, id) => void streams.delete(id),
  affectedBy: async (_tx, id, change) => {
    const s = streams.get(id);
    return s && (change.categoryChanged || change.droppedRouteCodes.includes(s.route)) ? [{ table: 'source_stream', id, label: 'Source stream: Anode carbon' }] : [];
  },
  applyChange: async (_tx, id) => {
    const s = streams.get(id);
    if (s) s.removed = true;
  },
};

const t = testApp({ processDependents: [fakeM6] });

type User = { a: TestAgent; id: string; email: string };
let admin: Awaited<ReturnType<typeof adminOfNewTenant>>;
let consultant: User;
let reviewer: User;
let contributor: User; // assigned to instA only
let recipient: User;
let clientId: string;
let instA: string;
let instB: string;

const api = (path: string) => `/api/v1${path}`;
const q = (value: string, unit = 't', extra: object = {}) => ({ value, unit, provenance: 'measured', source: 'Production log 2026', ...extra });
const ctxOf = (u: { id: string }, role: UserRole): RequestContext => ({ tenantId: admin.tenantId, userId: u.id, userRole: role, requestId: randomUUID() });

async function newInstallation() {
  const res = await consultant.a.post(api(`/clients/${clientId}/installations`), { nameEn: `Smelter ${randomUUID().slice(0, 6)}`, street: 's', city: 'Jamnagar', countryCode: 'IN' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.installation.id as string;
}

let year = 2026;
async function openVersion(installationId = instA) {
  const res = await consultant.a.post(api(`/installations/${installationId}/periods`), { startDate: `${year}-01-01`, endDate: `${year}-12-31` });
  year += 1;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { periodId: res.body.period.id as string, versionId: res.body.period.versions[0].id as string };
}

async function createProcess(versionId: string, body: object, who: TestAgent = consultant.a) {
  const res = await who.post(api(`/period-versions/${versionId}/processes`), body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.process as ProcessDetail;
}

const smelter = { name: 'Potline', goodsCategoryCode: 'unwrought_aluminium', routeCodes: ['primary_smelting'] };

async function addGood(processId: string, cnCode = '76011090', productName?: string) {
  const res = await consultant.a.post(api(`/processes/${processId}/goods`), { cnCode, ...(productName && { productName }) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.process as ProcessDetail;
}

const ALU_PARAMS = [
  { position: 2, quantity: q('0.05', 't/t') },
  { position: 3, quantity: q('0.3', '%') },
  { position: 4, quantity: q('0', '%') },
];

/** A complete, balanced aluminium process: 1,000 t by primary smelting, one good of 1,000 t. */
async function balancedProcess(versionId: string, name = 'Potline') {
  const p = await createProcess(versionId, { ...smelter, name });
  const withGood = await addGood(p.id);
  const prod = await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('1000') }], nonCbam: null, internalUses: [] });
  expect(prod.status, JSON.stringify(prod.body)).toBe(200);
  const data = await consultant.a.put(api(`/process-goods/${withGood.goods[0]!.id}/data`), { produced: q('1000'), soldEu: q('600'), soldOther: q('300'), parameters: ALU_PARAMS });
  expect(data.status, JSON.stringify(data.body)).toBe(200);
  return data.body.process as ProcessDetail;
}

const move = (who: TestAgent, versionId: string, action: string) => who.post(api(`/period-versions/${versionId}/transitions`), { action });

beforeAll(async () => {
  admin = await adminOfNewTenant(t);
  const c = await inviteAndAccept(t, admin.a, 'consultant', 'Cara Consultant');
  consultant = { ...(await signInWithMfa(t, c.email)), ...c };
  const r = await inviteAndAccept(t, admin.a, 'reviewer', 'Rhea Reviewer');
  reviewer = { a: (await signIn(t, r.email)).a, ...r };
  const k = await inviteAndAccept(t, admin.a, 'contributor', 'Kiran Contributor');
  contributor = { a: (await signIn(t, k.email)).a, ...k };
  const rc = await inviteAndAccept(t, admin.a, 'recipient', 'Rita Recipient');
  recipient = { a: (await signIn(t, rc.email)).a, ...rc };
  const client = await consultant.a.post(api('/clients'), {
    legalName: `Aurum Metals ${randomUUID().slice(0, 6)}`,
    addressLine1: '12 Marine Drive',
    city: 'Mumbai',
    countryCode: 'IN',
    contactName: 'Ravi Mehta',
    contactEmail: 'ravi@aurum.example',
  });
  clientId = client.body.client.id;
  instA = await newInstallation();
  instB = await newInstallation();
  for (const u of [reviewer, recipient]) expect((await admin.a.put(api(`/clients/${clientId}/team/${u.id}`))).status).toBe(204);
  expect((await admin.a.put(api(`/installations/${instA}/team/${contributor.id}`))).status).toBe(204);
});

afterAll(() => t.close());

// ---------------------------------------------------------------------------

describe('M5-R1 category and route from the library; routes filtered by category', () => {
  it('creates a process as P1 with one route row per route, draft', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, { ...smelter, routeCodes: ['primary_smelting', 'secondary_melting'] });
    expect(p).toMatchObject({ position: 1, name: 'Potline', status: 'draft', goodsCategory: { code: 'unwrought_aluminium', unit: 't' }, routeRelevant: true });
    expect(p.routes.map((r) => r.routeCode)).toEqual(['primary_smelting', 'secondary_melting']);
    expect(p.routes.every((r) => r.amount === null)).toBe(true);
    const list = (await consultant.a.get(api(`/period-versions/${versionId}/processes`))).body as ProcessList;
    expect(list).toMatchObject({ locked: false, libraryVersion: { code: '2026.1' }, processes: [{ id: p.id, position: 1 }] });
  });

  it('rejects a route of another category, an unknown category, and a route-relevant category without routes', async () => {
    const { versionId } = await openVersion();
    const wrongRoute = await consultant.a.post(api(`/period-versions/${versionId}/processes`), { ...smelter, routeCodes: ['eaf'] });
    expect(wrongRoute.status).toBe(400);
    expect(wrongRoute.body.error.issues).toEqual([{ path: ['routeCodes', 0], message: 'Choose a route of Unwrought aluminium.' }]);
    const unknown = await consultant.a.post(api(`/period-versions/${versionId}/processes`), { ...smelter, goodsCategoryCode: 'gold' });
    expect(unknown.body.error.issues).toEqual([{ path: ['goodsCategoryCode'], message: 'Choose a goods category from the list.' }]);
    const none = await consultant.a.post(api(`/period-versions/${versionId}/processes`), { ...smelter, routeCodes: [] });
    expect(none.body.error.issues).toEqual([{ path: ['routeCodes'], message: 'Choose at least one production route.' }]);
  });

  it('a category without routes gets one route row with no route; a route is refused for it', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, { name: 'Grinding', goodsCategoryCode: 'cement' });
    expect(p.routeRelevant).toBe(false);
    expect(p.routes).toMatchObject([{ routeCode: null, routeName: null, amount: null }]);
    const bad = await consultant.a.post(api(`/period-versions/${versionId}/processes`), { name: 'Grinding 2', goodsCategoryCode: 'cement', routeCodes: ['primary_smelting'] });
    expect(bad.status).toBe(400);
  });

  it('D16: included categories must be relevant precursors (bubble approach)', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, {
      name: 'Integrated plant',
      goodsCategoryCode: 'aluminium_products',
      includedCategories: [{ code: 'unwrought_aluminium', routeCodes: ['primary_smelting'] }],
    });
    expect(p.includedCategories).toEqual([{ code: 'unwrought_aluminium', name: 'Unwrought aluminium', routeCodes: ['primary_smelting'] }]);
    const bad = await consultant.a.post(api(`/period-versions/${versionId}/processes`), {
      name: 'Odd plant',
      goodsCategoryCode: 'aluminium_products',
      includedCategories: [{ code: 'cement', routeCodes: [] }],
    });
    expect(bad.body.error.issues).toEqual([{ path: ['includedCategories', 0, 'code'], message: 'Choose a relevant precursor of Aluminium products.' }]);
    // The database holds too.
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.insertInto('process_included_category').values({
          tenant_id: admin.tenantId, client_id: clientId, installation_id: instA, period_version_id: versionId,
          library_version_id: p.libraryVersionId, process_id: p.id, goods_category_code: 'cement', route_codes: [],
        } as never).execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('D16: at most ten processes per period; names are unique per period', async () => {
    const { versionId } = await openVersion();
    for (let i = 1; i <= 10; i++) await createProcess(versionId, { name: `Line ${i}`, goodsCategoryCode: 'cement' });
    const eleventh = await consultant.a.post(api(`/period-versions/${versionId}/processes`), { name: 'Line 11', goodsCategoryCode: 'cement' });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error.code).toBe('too_many_processes');
    const { versionId: v2 } = await openVersion();
    await createProcess(v2, { name: 'Kiln', goodsCategoryCode: 'cement' });
    const dup = await consultant.a.post(api(`/period-versions/${v2}/processes`), { name: ' kiln ', goodsCategoryCode: 'cement' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('Another process of this period already has this name.');
  });
});

describe('M5-R2 CN codes from the library, of the chosen category', () => {
  it('AT1: aluminium process + cement CN code is rejected, by the API and by the database', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, smelter);
    const res = await consultant.a.post(api(`/processes/${p.id}/goods`), { cnCode: '2523 2900' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: ['cnCode'], message: 'CN code 25232900 is Cement, not Unwrought aluminium. Add it to a process for Cement.' }]);
    const unknown = await consultant.a.post(api(`/processes/${p.id}/goods`), { cnCode: '99999999' });
    expect(unknown.body.error.issues[0].message).toContain('is not a CBAM good');
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.insertInto('process_good').values({
          tenant_id: admin.tenantId, client_id: clientId, installation_id: instA, period_version_id: versionId,
          library_version_id: p.libraryVersionId, goods_category_code: 'unwrought_aluminium', process_id: p.id, cn_code: '25232900',
        } as never).execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('one process makes several CN codes; the same code twice needs different product names', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, smelter);
    await addGood(p.id, '76011010');
    const two = await addGood(p.id, '76011090', 'P1020 ingot');
    expect(two.goods.map((g) => [g.cnCode, g.productName])).toEqual([['76011010', null], ['76011090', 'P1020 ingot']]);
    expect(two.goods[0]!.cnDescription).toBe('Aluminium slabs, not alloyed, unwrought');
    const dup = await consultant.a.post(api(`/processes/${p.id}/goods`), { cnCode: '76011010' });
    expect(dup.status).toBe(409);
    expect((await addGood(p.id, '76011010', 'Sow')).goods).toHaveLength(3);
  });
});

describe('M5-R3 production balance (D17, D19, D20)', () => {
  it('AT2: CN quantities of 1,200 t against 1,000 t production raise a critical check and block completion', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    expect(p.balance).toMatchObject({ activityLevel: '1000', goods: '1000', difference: '0', tolerance: '0.005', withinTolerance: true });
    const good = p.goods[0]!;
    const over = await consultant.a.put(api(`/process-goods/${good.id}/data`), { produced: q('1200'), soldEu: null, soldOther: null, parameters: ALU_PARAMS });
    const detail = over.body.process as ProcessDetail;
    expect(detail.checks).toMatchObject([{ ruleId: 'M5-C05', severity: 'critical', record: { type: 'production_process', id: p.id } }]);
    const list = (await consultant.a.get(api(`/period-versions/${versionId}/processes`))).body as ProcessList;
    expect(list.processes[0]!.openChecks).toEqual({ critical: 1, warning: 0 });
    expect(list.checks.map((c) => c.ruleId)).toEqual(['M5-C05']);
    const complete = await consultant.a.post(api(`/processes/${p.id}/complete`));
    expect(complete.status).toBe(409);
    expect(complete.body.error).toMatchObject({ code: 'checks_open', message: "This process can't be marked complete: 1 critical check is open." });
  });

  it('internal use and non-CBAM consumption close the balance; completing works; any change returns to draft', async () => {
    const { versionId } = await openVersion();
    const rolling = await createProcess(versionId, { name: 'Rolling mill', goodsCategoryCode: 'aluminium_products' });
    const p = await balancedProcess(versionId);
    await consultant.a.put(api(`/process-goods/${p.goods[0]!.id}/data`), { produced: q('700'), soldEu: null, soldOther: null, parameters: ALU_PARAMS });
    const prod = await consultant.a.put(api(`/processes/${p.id}/production`), {
      routes: [{ routeId: p.routes[0]!.id, amount: q('1000') }],
      nonCbam: q('50000', 'kg'),
      internalUses: [{ consumerProcessId: rolling.id, amount: q('0.25', 'kt') }],
    });
    expect(prod.status, JSON.stringify(prod.body)).toBe(200);
    expect((prod.body.process as ProcessDetail).balance).toMatchObject({ internalUse: '250', nonCbam: '50', difference: '0', withinTolerance: true });
    expect((prod.body.process as ProcessDetail).internalUses).toMatchObject([{ consumerProcessId: rolling.id, consumerName: 'Rolling mill', amount: { value: '0.25', unit: 'kt', si: '250' } }]);

    const done = await consultant.a.post(api(`/processes/${p.id}/complete`));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.process).toMatchObject({ status: 'complete', completedBy: 'Cara Consultant' });
    // A contributor's data change reopens it.
    const edit = await contributor.a.put(api(`/process-goods/${p.goods[0]!.id}/data`), { produced: q('701'), soldEu: null, soldOther: null, parameters: ALU_PARAMS });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.process).toMatchObject({ status: 'draft', completedAt: null });
  });

  it('the tolerance comes from the pinned library version (D19)', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    const within = await consultant.a.put(api(`/process-goods/${p.goods[0]!.id}/data`), { produced: q('1004.9'), soldEu: null, soldOther: null, parameters: ALU_PARAMS });
    expect((within.body.process as ProcessDetail).checks).toEqual([]);
    const settings = await consultant.a.get(api(`/library/versions/${p.libraryVersionId}/settings`));
    expect(settings.body.settings).toEqual({ productionBalanceTolerance: '0.005' });
  });

  it('amounts must use the unit of the category, and cannot be negative', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, smelter);
    const mwh = await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('10', 'MWh') }], nonCbam: null, internalUses: [] });
    expect(mwh.status).toBe(400);
    expect(mwh.body.error.issues).toEqual([{ path: ['routes', 0, 'amount', 'unit'], message: 'Enter this amount in kg, t or kt.' }]);
    const neg = await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('-1') }], nonCbam: null, internalUses: [] });
    expect(neg.status).toBe(400);
    const self = await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [], nonCbam: null, internalUses: [{ consumerProcessId: p.id, amount: q('1') }] });
    expect(self.body.error.issues).toEqual([{ path: ['internalUses', 0, 'consumerProcessId'], message: 'Choose another process of this period.' }]);
  });

  it('G5: stores value, unit, SI value, source and provenance; a default needs its library reference', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, smelter);
    const res = await consultant.a.put(api(`/processes/${p.id}/production`), {
      routes: [{ routeId: p.routes[0]!.id, amount: q('1.5', 'kt', { provenance: 'estimated', source: 'Monthly reports' }) }], nonCbam: null, internalUses: [],
    });
    expect((res.body.process as ProcessDetail).routes[0]!.amount).toEqual({ value: '1.5', unit: 'kt', si: '1500', source: 'Monthly reports', provenance: 'estimated', defaultRef: null });
    const noRef = await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('1', 't', { provenance: 'default' }) }], nonCbam: null, internalUses: [] });
    expect(noRef.status).toBe(400);
    const { rows } = await sql<{ amount_value: string; amount_si: string }>`select amount_value, amount_si from process_route where id = ${p.routes[0]!.id}`.execute(t.su);
    expect(rows[0]).toEqual({ amount_value: '1.5', amount_si: '1500' });
  });
});

describe('independent review M5: fixes', () => {
  it('F1: an internal use without an amount blocks completion, so goods above production cannot slip through', async () => {
    const { versionId } = await openVersion();
    const rolling = await createProcess(versionId, { name: 'Rolling mill', goodsCategoryCode: 'aluminium_products' });
    const p = await balancedProcess(versionId);
    await consultant.a.put(api(`/process-goods/${p.goods[0]!.id}/data`), { produced: q('1200'), soldEu: null, soldOther: null, parameters: ALU_PARAMS });
    const prod = await consultant.a.put(api(`/processes/${p.id}/production`), {
      routes: [{ routeId: p.routes[0]!.id, amount: q('1000') }], nonCbam: null, internalUses: [{ consumerProcessId: rolling.id, amount: null }],
    });
    expect((prod.body.process as ProcessDetail).checks).toMatchObject([{ ruleId: 'M5-C06', severity: 'critical' }]);
    expect((await consultant.a.post(api(`/processes/${p.id}/complete`))).status).toBe(409);
  });

  it('F2: deleting a consuming process returns its complete suppliers to draft', async () => {
    const { versionId } = await openVersion();
    const rolling = await createProcess(versionId, { name: 'Rolling mill', goodsCategoryCode: 'aluminium_products' });
    const p = await balancedProcess(versionId);
    await consultant.a.put(api(`/process-goods/${p.goods[0]!.id}/data`), { produced: q('900'), soldEu: null, soldOther: null, parameters: ALU_PARAMS });
    await consultant.a.put(api(`/processes/${p.id}/production`), {
      routes: [{ routeId: p.routes[0]!.id, amount: q('1000') }], nonCbam: null, internalUses: [{ consumerProcessId: rolling.id, amount: q('100') }],
    });
    expect((await consultant.a.post(api(`/processes/${p.id}/complete`))).status).toBe(200);
    expect((await consultant.a.delete(api(`/processes/${rolling.id}?confirm=true`))).status).toBe(204);
    const after = (await consultant.a.get(api(`/processes/${p.id}`))).body.process as ProcessDetail;
    expect(after).toMatchObject({ status: 'draft', internalUses: [] });
    expect(after.checks.map((c) => c.ruleId)).toEqual(['M5-C05']);
  });

  it('F3: a category change and a new process at the same time cannot exceed ten categories', async () => {
    const { versionId } = await openVersion();
    const cats = ['cement', 'cement_clinker', 'calcined_clays', 'aluminous_cement', 'urea', 'aluminium_products', 'nitric_acid', 'dri', 'mixed_fertilisers'];
    for (const c of cats) await createProcess(versionId, { name: `P ${c}`, goodsCategoryCode: c });
    const second = await createProcess(versionId, { name: 'Second cement mill', goodsCategoryCode: 'cement' });
    // 9 categories. Each request alone makes 10; together they would make 11.
    const [patch, post] = await Promise.all([
      consultant.a.patch(api(`/processes/${second.id}`), { goodsCategoryCode: 'iron_steel_products', confirm: true }),
      consultant.a.post(api(`/period-versions/${versionId}/processes`), { name: 'Blast furnace', goodsCategoryCode: 'pig_iron', routeCodes: ['blast_furnace_route'] }),
    ]);
    expect([patch.status, post.status].filter((x) => x < 300)).toHaveLength(1);
    const list = (await consultant.a.get(api(`/period-versions/${versionId}/processes`))).body as ProcessList;
    expect(new Set(list.processes.map((x) => x.goodsCategory.code)).size).toBe(10);
  });

  it('F4: a share above 100 % or below zero is refused with a field message, not a 500', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, smelter);
    const g = (await addGood(p.id)).goods[0]!;
    const put = (quantity: object) => consultant.a.put(api(`/process-goods/${g.id}/data`), { produced: null, soldEu: null, soldOther: null, parameters: [{ position: 3, quantity }] });
    const high = await put(q('150', '%'));
    expect(high.status).toBe(400);
    expect(high.body.error.issues).toEqual([{ path: ['parameters', 0, 'quantity', 'value'], message: '% non-aluminium elements cannot be more than 100 %.' }]);
    expect((await put(q('-1', '%'))).status).toBe(400);
    expect((await put(q('1', 'fraction'))).status).toBe(200);
  });

  it('F5: a data source over 500 characters is a field error, not a 500', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, smelter);
    const res = await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('1', 't', { source: 'x'.repeat(501) }) }], nonCbam: null, internalUses: [] });
    expect(res.status).toBe(400);
  });

  it('F6: later modules list and handle their records when a route they use is removed', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, { ...smelter, routeCodes: ['primary_smelting', 'secondary_melting'] });
    streams.set(p.id, { route: 'primary_smelting', removed: false });
    const warn = await consultant.a.patch(api(`/processes/${p.id}`), { routeCodes: ['secondary_melting'] });
    expect(warn.status).toBe(409);
    expect(warn.body.error.details.affected).toEqual([{ table: 'source_stream', id: p.id, label: 'Source stream: Anode carbon' }]);
    expect(streams.get(p.id)!.removed).toBe(false);
    expect((await consultant.a.patch(api(`/processes/${p.id}`), { routeCodes: ['secondary_melting'], confirm: true })).status).toBe(200);
    expect(streams.get(p.id)!.removed).toBe(true);
    // Deleting the process lists them too.
    const del = await consultant.a.delete(api(`/processes/${p.id}`));
    expect(del.body.error.details.affected.map((x: { table: string }) => x.table)).toEqual(['source_stream']);
    expect((await consultant.a.delete(api(`/processes/${p.id}?confirm=true`))).status).toBe(204);
    expect(streams.has(p.id)).toBe(false);
  });

  it('F9: the audit action names what happened', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    await consultant.a.patch(api(`/processes/${p.id}`), { name: 'Potline A', goodsCategoryCode: 'unwrought_aluminium' });
    await consultant.a.patch(api(`/processes/${p.id}`), { routeCodes: ['secondary_melting'], confirm: true });
    const { rows } = await sql<{ action: string; op: string }>`
      select action, op from audit.audit_log where record_id in (${p.id}, ${p.routes[0]!.id}) and op in ('UPDATE', 'DELETE') order by id`.execute(t.su);
    expect(rows.map((r) => r.action)).toContain('Remove route');
    expect(rows.map((r) => r.action)).not.toContain('Change goods category');
  });

  it('F10: an included category with routes must name at least one', async () => {
    const { versionId } = await openVersion();
    const res = await consultant.a.post(api(`/period-versions/${versionId}/processes`), {
      name: 'Integrated', goodsCategoryCode: 'aluminium_products', includedCategories: [{ code: 'unwrought_aluminium', routeCodes: [] }],
    });
    expect(res.body.error.issues).toEqual([{ path: ['includedCategories', 0, 'routeCodes'], message: 'Choose the routes Unwrought aluminium is made by.' }]);
  });
});

describe('M5-R4 qualifying parameters as configured in M4 (D18)', () => {
  it('the library back-fill marks N content required and the reducing agent an optional choice', async () => {
    const current = (await consultant.a.get(api('/library/versions/current'))).body.version;
    const goods = (await consultant.a.get(api(`/library/versions/${current.id}/goods`))).body.goods as { code: string; qualifyingParameters: object[] }[];
    expect(goods.find((g) => g.code === 'urea')!.qualifyingParameters).toEqual([
      { position: 2, name: '% urea', required: true, valueKind: 'number', dimension: 'fraction', choices: null },
      { position: 3, name: '% N contained', required: true, valueKind: 'number', dimension: 'fraction', choices: null },
    ]);
    expect(goods.find((g) => g.code === 'crude_steel')!.qualifyingParameters[0]).toEqual({
      position: 1, name: 'The main reducing agent of the precursor, if known', required: false, valueKind: 'choice', dimension: null,
      choices: ['Coal or coke', 'Natural gas', 'Biogas', 'Hydrogen'],
    });
    expect(goods.find((g) => g.code === 'unwrought_aluminium')!.qualifyingParameters[0]).toMatchObject({ name: 't scrap per t aluminium', dimension: 'mass_ratio' });
  });

  it('AT3: a fertiliser process without N content cannot be marked complete', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, { name: 'Urea synthesis', goodsCategoryCode: 'urea' });
    const g = (await addGood(p.id, '31021010')).goods[0]!;
    await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('500') }], nonCbam: null, internalUses: [] });
    const partial = await consultant.a.put(api(`/process-goods/${g.id}/data`), { produced: q('500'), soldEu: null, soldOther: null, parameters: [{ position: 2, quantity: q('98.5', '%') }] });
    expect((partial.body.process as ProcessDetail).checks).toMatchObject([{ ruleId: 'M5-C04', message: '31021010: enter % N contained.' }]);
    expect((await consultant.a.post(api(`/processes/${p.id}/complete`))).status).toBe(409);
    await consultant.a.put(api(`/process-goods/${g.id}/data`), {
      produced: q('500'), soldEu: null, soldOther: null,
      parameters: [{ position: 2, quantity: q('98.5', '%') }, { position: 3, quantity: q('0.46', 'fraction') }],
    });
    expect((await consultant.a.post(api(`/processes/${p.id}/complete`))).status).toBe(200);
  });

  it('values must match the kind, dimension and choices of the definition', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, { name: 'EAF shop', goodsCategoryCode: 'crude_steel', routeCodes: ['electric_arc_furnace'] });
    const g = (await addGood(p.id, '72061000')).goods[0]!;
    const put = (parameters: object[]) => consultant.a.put(api(`/process-goods/${g.id}/data`), { produced: null, soldEu: null, soldOther: null, parameters });
    expect((await put([{ position: 1, text: 'Charcoal' }])).body.error.issues).toEqual([{ path: ['parameters', 0, 'text'], message: 'Choose one of: Coal or coke, Natural gas, Biogas, Hydrogen.' }]);
    expect((await put([{ position: 1, quantity: q('1', '%') }])).body.error.issues[0].message).toBe('Enter The main reducing agent of the precursor, if known.');
    expect((await put([{ position: 6, quantity: q('5', '%') }])).body.error.issues).toEqual([{ path: ['parameters', 0, 'quantity', 'unit'], message: 'Enter this as t/t or kg/t.' }]);
    expect((await put([{ position: 9, text: 'x' }])).status).toBe(400);
    const ok = await put([{ position: 1, text: 'Natural gas' }, { position: 6, quantity: q('1100', 'kg/t') }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body.process as ProcessDetail).goods[0]!.parameters).toMatchObject([
      { position: 1, text: 'Natural gas', quantity: null },
      { position: 6, text: null, quantity: { value: '1100', unit: 'kg/t', si: '1.1' } },
    ]);
    // Clearing a value removes it.
    const cleared = await put([{ position: 1, text: null }]);
    expect((cleared.body.process as ProcessDetail).goods[0]!.parameters).toEqual([]);
  });
});

describe('M5-R5 changing category or routes after data entry warns and lists affected records', () => {
  it('a category change lists goods, routes with production and parameters, and applies only when confirmed', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    const change = { goodsCategoryCode: 'aluminium_products' };
    const warn = await consultant.a.patch(api(`/processes/${p.id}`), change);
    expect(warn.status).toBe(409);
    expect(warn.body.error.code).toBe('confirm_required');
    expect(warn.body.error.details.affected.map((a: { label: string }) => a.label)).toEqual([
      'Production by Primary (electrolytic) smelting: 1,000 t',
      'Good 76011090: 1,000 t produced, 3 qualifying parameters',
    ]);
    // Nothing changed.
    expect((await consultant.a.get(api(`/processes/${p.id}`))).body.process.goods).toHaveLength(1);

    const done = await consultant.a.patch(api(`/processes/${p.id}`), { ...change, confirm: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.process).toMatchObject({ goodsCategory: { code: 'aluminium_products' }, goods: [], routes: [{ routeCode: null, amount: null }], status: 'draft' });
    const { rows } = await sql<{ action: string; table_name: string; op: string }>`
      select action, table_name, op from audit.audit_log
       where table_name in ('public.process_good', 'public.process_good_parameter') and (old_row ->> 'process_id' = ${p.id} or old_row ->> 'good_id' = ${p.goods[0]!.id})
         and op = 'DELETE'`.execute(t.su);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.action === 'Change goods category')).toBe(true);
  });

  it('removing a route with production needs confirmation; adding one or renaming does not', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    const add = await consultant.a.patch(api(`/processes/${p.id}`), { routeCodes: ['primary_smelting', 'secondary_melting'], name: 'Potline 1' });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.process.routes.map((r: { routeCode: string }) => r.routeCode)).toEqual(['primary_smelting', 'secondary_melting']);
    const drop = await consultant.a.patch(api(`/processes/${p.id}`), { routeCodes: ['secondary_melting'] });
    expect(drop.status).toBe(409);
    expect(drop.body.error.details.affected).toMatchObject([{ table: 'process_route', label: 'Production by Primary (electrolytic) smelting: 1,000 t' }]);
    const ok = await consultant.a.patch(api(`/processes/${p.id}`), { routeCodes: ['secondary_melting'], confirm: true });
    expect(ok.body.process.routes).toMatchObject([{ routeCode: 'secondary_melting', amount: null }]);
  });
});

describe('M5-R6 deleting a process with data needs confirmation and is logged', () => {
  it('an empty process is deleted at once', async () => {
    const { versionId } = await openVersion();
    const p = await createProcess(versionId, smelter);
    expect((await consultant.a.delete(api(`/processes/${p.id}`))).status).toBe(204);
  });

  it('lists routes, goods, internal use and evidence; deletes all of it only with confirm=true', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    const other = await balancedProcess(versionId, 'Potline 2');
    await consultant.a.put(api(`/processes/${other.id}/production`), {
      routes: [{ routeId: other.routes[0]!.id, amount: q('1000') }], nonCbam: null, internalUses: [{ consumerProcessId: p.id, amount: q('0') }],
    });
    const ev = await consultant.a.raw
      .post(api(`/clients/${clientId}/evidence`))
      .query({ fileName: 'potline.pdf', docType: 'other', recordType: 'production_process', recordId: p.id, installationId: instA })
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(`%PDF-1.7\n${randomUUID()}\n%%EOF`));
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect(ev.body.evidence.links[0].label).toBe('Process: Potline');

    const warn = await consultant.a.delete(api(`/processes/${p.id}`));
    expect(warn.status).toBe(409);
    expect(warn.body.error.details.affected.map((a: { table: string }) => a.table)).toEqual(['process_route', 'process_good', 'process_internal_use', 'evidence_link']);
    const del = await consultant.a.delete(api(`/processes/${p.id}?confirm=true`));
    expect(del.status).toBe(204);
    expect((await consultant.a.get(api(`/processes/${p.id}`))).status).toBe(404);
    // The other process lost its internal use to the deleted one; the evidence file stays.
    expect((await consultant.a.get(api(`/processes/${other.id}`))).body.process.internalUses).toEqual([]);
    expect((await consultant.a.get(api(`/evidence/${ev.body.evidence.id}`))).body.evidence.links).toEqual([]);
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from audit.audit_log where action = 'Delete process' and op = 'DELETE'`.execute(t.su);
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(6); // process, route, good, 3 parameters, internal use, link
  });

  it('deleting a good with data needs confirmation too', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    const warn = await consultant.a.delete(api(`/process-goods/${p.goods[0]!.id}`));
    expect(warn.status).toBe(409);
    const ok = await consultant.a.delete(api(`/process-goods/${p.goods[0]!.id}?confirm=true`));
    expect(ok.body.process.goods).toEqual([]);
  });
});

describe('G2 / D21 roles and assignments, in the API and the database', () => {
  it('contributors of the installation enter data but cannot change the set-up', async () => {
    const { versionId } = await openVersion(instA);
    const p = await createProcess(versionId, smelter);
    expect((await contributor.a.post(api(`/period-versions/${versionId}/processes`), smelter)).status).toBe(403);
    expect((await contributor.a.patch(api(`/processes/${p.id}`), { name: 'Mine' })).status).toBe(403);
    expect((await contributor.a.post(api(`/processes/${p.id}/goods`), { cnCode: '76011090' })).status).toBe(403);
    expect((await contributor.a.post(api(`/processes/${p.id}/complete`))).status).toBe(403);
    expect((await contributor.a.delete(api(`/processes/${p.id}`))).status).toBe(403);
    const data = await contributor.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('10') }], nonCbam: null, internalUses: [] });
    expect(data.status, JSON.stringify(data.body)).toBe(200);
    // The database refuses a set-up change or a completion by a contributor.
    const ctx = ctxOf(contributor, 'contributor');
    await expect(withContext(t.db, ctx, (tx) => tx.updateTable('production_process').set({ name: 'Mine' }).where('id', '=', p.id).execute())).rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.db, ctx, (tx) => tx.updateTable('production_process').set({ status: 'complete' }).where('id', '=', p.id).execute())).rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.db, ctx, (tx) => tx.updateTable('process_route').set({ route_code: 'secondary_melting' }).where('id', '=', p.routes[0]!.id).execute())).rejects.toMatchObject({ code: '42501' });
    const deleted = await withContext(t.db, ctx, (tx) => tx.deleteFrom('production_process').where('id', '=', p.id).executeTakeFirst());
    expect(deleted.numDeletedRows).toBe(0n);
  });

  it('contributors of another installation, and recipients, see nothing; reviewers read only', async () => {
    const { versionId } = await openVersion(instB);
    const p = await createProcess(versionId, smelter);
    expect((await contributor.a.get(api(`/processes/${p.id}`))).status).toBe(404);
    expect((await contributor.a.get(api(`/period-versions/${versionId}/processes`))).status).toBe(404);
    expect((await contributor.a.put(api(`/processes/${p.id}/production`), { routes: [], nonCbam: null, internalUses: [] })).status).toBe(404);
    expect((await recipient.a.get(api(`/processes/${p.id}`))).status).toBe(403);
    const rows = await withContext(t.db, ctxOf(recipient, 'recipient'), (tx) => tx.selectFrom('production_process').select('id').where('id', '=', p.id).execute());
    expect(rows).toEqual([]);
    expect((await reviewer.a.get(api(`/processes/${p.id}`))).status).toBe(200);
    expect((await reviewer.a.put(api(`/processes/${p.id}/production`), { routes: [], nonCbam: null, internalUses: [] })).status).toBe(403);
  });
});

describe('G4 / M3-R4 approved and issued periods are read-only', () => {
  it('refuses every write in the API (409) and in the database (55000)', async () => {
    const { versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    expect((await move(consultant.a, versionId, 'submit')).status).toBe(200);
    expect((await move(reviewer.a, versionId, 'approve')).status).toBe(200);
    const list = (await consultant.a.get(api(`/period-versions/${versionId}/processes`))).body as ProcessList;
    expect(list.locked).toBe(true);
    const writes = [
      consultant.a.post(api(`/period-versions/${versionId}/processes`), { ...smelter, name: 'Late' }),
      consultant.a.patch(api(`/processes/${p.id}`), { name: 'Renamed' }),
      consultant.a.delete(api(`/processes/${p.id}?confirm=true`)),
      consultant.a.post(api(`/processes/${p.id}/goods`), { cnCode: '76011010' }),
      consultant.a.put(api(`/processes/${p.id}/production`), { routes: [], nonCbam: null, internalUses: [] }),
      consultant.a.put(api(`/process-goods/${p.goods[0]!.id}/data`), { produced: null, soldEu: null, soldOther: null, parameters: [] }),
      consultant.a.post(api(`/processes/${p.id}/complete`)),
    ];
    for (const res of await Promise.all(writes)) expect(res.status, JSON.stringify(res.body)).toBe(409);
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) => tx.updateTable('process_good').set({ product_name: 'x' }).where('id', '=', p.goods[0]!.id).execute()),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

describe('M3-R5 / R6 new versions and clones (D23)', () => {
  it('clone copies the set-up without quantities or parameter values', async () => {
    const { periodId, versionId } = await openVersion();
    const rolling = await createProcess(versionId, { name: 'Rolling mill', goodsCategoryCode: 'aluminium_products', includedCategories: [{ code: 'unwrought_aluminium', routeCodes: ['secondary_melting'] }] });
    const p = await balancedProcess(versionId);
    await consultant.a.put(api(`/processes/${p.id}/production`), { routes: [{ routeId: p.routes[0]!.id, amount: q('1000') }], nonCbam: null, internalUses: [{ consumerProcessId: rolling.id, amount: q('0') }] });
    const clone = await consultant.a.post(api(`/periods/${periodId}/clone`), { startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    year += 1;
    expect(clone.status, JSON.stringify(clone.body)).toBe(201);
    expect(clone.body.notes).toEqual([]);
    const list = (await consultant.a.get(api(`/period-versions/${clone.body.period.versions[0].id}/processes`))).body as ProcessList;
    expect(list.processes.map((x) => [x.position, x.name, x.status])).toEqual([[1, 'Rolling mill', 'draft'], [2, 'Potline', 'draft']]);
    const copy = (await consultant.a.get(api(`/processes/${list.processes[1]!.id}`))).body.process as ProcessDetail;
    expect(copy.routes).toMatchObject([{ routeCode: 'primary_smelting', amount: null }]);
    expect(copy.goods).toMatchObject([{ cnCode: '76011090', produced: null, soldEu: null, parameters: [] }]);
    expect(copy.internalUses).toMatchObject([{ consumerName: 'Rolling mill', amount: null }]);
    const rollingCopy = (await consultant.a.get(api(`/processes/${list.processes[0]!.id}`))).body.process as ProcessDetail;
    expect(rollingCopy.includedCategories).toEqual([{ code: 'unwrought_aluminium', name: 'Unwrought aluminium', routeCodes: ['secondary_melting'] }]);
  });

  it('a new version copies all data and the evidence links of processes and goods', async () => {
    const { periodId, versionId } = await openVersion();
    const p = await balancedProcess(versionId);
    const ev = await consultant.a.raw
      .post(api(`/clients/${clientId}/evidence`))
      .query({ fileName: 'assay.pdf', docType: 'lab_report', recordType: 'process_good', recordId: p.goods[0]!.id, installationId: instA })
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(`%PDF-1.7\n${randomUUID()}\n%%EOF`));
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect((await consultant.a.post(api(`/processes/${p.id}/complete`))).status).toBe(200);
    for (const [who, action] of [[consultant, 'submit'], [reviewer, 'approve'], [consultant, 'issue']] as const) {
      expect((await move(who.a, versionId, action)).status).toBe(200);
    }
    const v2 = await consultant.a.post(api(`/periods/${periodId}/versions`));
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    const newId = v2.body.period.versions[0].id as string;
    const list = (await consultant.a.get(api(`/period-versions/${newId}/processes`))).body as ProcessList;
    const copy = (await consultant.a.get(api(`/processes/${list.processes[0]!.id}`))).body.process as ProcessDetail;
    expect(copy).toMatchObject({ name: 'Potline', status: 'draft', balance: { activityLevel: '1000', difference: '0' } });
    expect(copy.goods[0]).toMatchObject({ cnCode: '76011090', produced: { si: '1000' }, soldEu: { si: '600' } });
    expect(copy.goods[0]!.parameters).toHaveLength(3);
    const evidence = (await consultant.a.get(api(`/evidence/${ev.body.evidence.id}`))).body.evidence;
    expect(evidence.links.map((l: { recordId: string }) => l.recordId).sort()).toEqual([p.goods[0]!.id, copy.goods[0]!.id].sort());
    // Version 1 is untouched.
    expect(((await consultant.a.get(api(`/processes/${p.id}`))).body.process as ProcessDetail).status).toBe('complete');
  });
});

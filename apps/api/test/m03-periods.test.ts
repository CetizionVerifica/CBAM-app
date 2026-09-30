import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@cbam/shared';
import type { ApprovalGuard } from '../src/modules/m03-periods';
import { assertPeriodWritable } from '../src/modules/m03-periods';
import { type RequestContext, withContext } from '../src/platform/db';
import { type TestAgent, adminOfNewTenant, inviteAndAccept, signIn, signInWithMfa, testApp } from './helpers';

// M3 — Reporting period manager, plus M2 AT3 (installation with periods cannot be deleted).
// Requirement IDs from .claude/skills/cbam-module-reviewer/references/modules/M03-reporting-period.md

// M3-R7: a stand-in for M11. Approval is blocked while this set holds the version id.
const blocked = new Set<string>();
const openCriticalIssues: ApprovalGuard = async (_tx, id) => (blocked.has(id) ? [{ message: '2 blocking issues are open.' }] : []);

const t = testApp({ periodHooks: { approvalGuards: [openCriticalIssues], setupCopiers: [], versionCopiers: [] } });

type User = { a: TestAgent; id: string; email: string };
let admin: Awaited<ReturnType<typeof adminOfNewTenant>>;
let consultant: User;
let reviewer: User;
let contributor: User;
let outsider: User; // a consultant not assigned to the client
let clientId: string;
let instA: string; // contributor assigned here
let instB: string;

const api = (path: string) => `/api/v1${path}`;
const cal = (year: number) => ({ startDate: `${year}-01-01`, endDate: `${year}-12-31` });

const ctxOf = (u: { id: string }, role: UserRole, extra: Partial<RequestContext> = {}): RequestContext => ({
  tenantId: admin.tenantId,
  userId: u.id,
  userRole: role,
  requestId: randomUUID(),
  ...extra,
});

async function newInstallation(name = `Smelter ${randomUUID().slice(0, 6)}`) {
  const res = await consultant.a.post(api(`/clients/${clientId}/installations`), {
    nameEn: name,
    street: 'Plot 4, GIDC',
    city: 'Jamnagar',
    countryCode: 'IN',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.installation.id as string;
}

async function openPeriod(installationId: string, body: object = cal(2026), who: TestAgent = consultant.a) {
  const res = await who.post(api(`/installations/${installationId}/periods`), body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.period as { id: string; installationId: string; versions: { id: string; versionNo: number; status: string }[] };
}

const move = (who: TestAgent, versionId: string, action: string, reason?: string) =>
  who.post(api(`/period-versions/${versionId}/transitions`), { action, ...(reason && { reason }) });

/** Draft → in review → approved → issued. */
async function issue(versionId: string) {
  expect((await move(consultant.a, versionId, 'submit')).status).toBe(200);
  expect((await move(reviewer.a, versionId, 'approve')).status).toBe(200);
  const res = await move(consultant.a, versionId, 'issue');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.period;
}

beforeAll(async () => {
  admin = await adminOfNewTenant(t);
  const c = await inviteAndAccept(t, admin.a, 'consultant', 'Cara Consultant');
  consultant = { ...(await signInWithMfa(t, c.email)), ...c };
  const o = await inviteAndAccept(t, admin.a, 'consultant', 'Otto Outsider');
  outsider = { ...(await signInWithMfa(t, o.email)), ...o };
  const r = await inviteAndAccept(t, admin.a, 'reviewer', 'Rhea Reviewer');
  reviewer = { a: (await signIn(t, r.email)).a, ...r };
  const k = await inviteAndAccept(t, admin.a, 'contributor', 'Kiran Contributor');
  contributor = { a: (await signIn(t, k.email)).a, ...k };

  const client = await consultant.a.post(api('/clients'), {
    legalName: `Aurum Metals ${randomUUID().slice(0, 6)}`,
    addressLine1: '12 Marine Drive',
    city: 'Mumbai',
    countryCode: 'IN',
    contactName: 'Ravi Mehta',
    contactEmail: 'ravi@aurum.example',
  });
  clientId = client.body.client.id;
  instA = await newInstallation('Jamnagar smelter');
  instB = await newInstallation('Pune rolling mill');
  expect((await admin.a.put(api(`/clients/${clientId}/team/${reviewer.id}`))).status).toBe(204);
  expect((await admin.a.put(api(`/installations/${instA}/team/${contributor.id}`))).status).toBe(204);
});

afterAll(() => t.close());

// ---------------------------------------------------------------------------

describe('M3-R1 periods belong to one installation, without overlaps', () => {
  it('opens a period as version 1, draft, pinned to the current library and template', async () => {
    const inst = await newInstallation();
    const p = await openPeriod(inst);
    const detail = (await consultant.a.get(api(`/periods/${p.id}`))).body.period;
    expect(detail).toMatchObject({ installationId: inst, startDate: '2026-01-01', endDate: '2026-12-31', versionCount: 1, datesEditable: true });
    const current = (await consultant.a.get(api('/library/versions/current'))).body.version;
    expect(detail.versions[0]).toMatchObject({ versionNo: 1, status: 'draft', libraryVersion: { id: current.id }, basedOnVersionNo: null });
    expect(detail.versions[0].templateVersion.code).toBeTruthy();
    expect(detail.history).toMatchObject([{ fromStatus: null, toStatus: 'draft', changedBy: 'Cara Consultant' }]);
  });

  it('AT1: an overlapping period is rejected; adjacent periods and other installations are fine', async () => {
    const inst = await newInstallation();
    await openPeriod(inst, cal(2026));
    const overlap = await consultant.a.post(api(`/installations/${inst}/periods`), {
      startDate: '2026-07-01',
      endDate: '2027-06-30',
      justification: 'Financial year July to June',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toMatchObject({ code: 'overlap', message: 'This installation already has a reporting period that overlaps these dates.' });
    expect((await consultant.a.post(api(`/installations/${inst}/periods`), cal(2026))).status).toBe(409);
    await openPeriod(inst, cal(2027)); // 2027-01-01 follows 2026-12-31: touching, not overlapping
    await openPeriod(await newInstallation(), cal(2026));
  });

  it('AT1 holds in the database even for concurrent requests', async () => {
    const inst = await newInstallation();
    const results = await Promise.all([1, 2, 3].map(() => consultant.a.post(api(`/installations/${inst}/periods`), cal(2026))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('a period cannot be moved to another installation', async () => {
    const p = await openPeriod(await newInstallation());
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('reporting_period').set({ installation_id: instB }).where('id', '=', p.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('M3-R2 calendar year by default, other 12-month periods with a justification', () => {
  it('a non-calendar period needs a justification', async () => {
    const inst = await newInstallation();
    const res = await consultant.a.post(api(`/installations/${inst}/periods`), { startDate: '2026-04-01', endDate: '2027-03-31' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual([{ path: ['justification'], message: 'Say why this period does not follow the calendar year.' }]);
    const ok = await openPeriod(inst, { startDate: '2026-04-01', endDate: '2027-03-31', justification: 'Financial year April to March' });
    expect((await consultant.a.get(api(`/periods/${ok.id}`))).body.period.justification).toBe('Financial year April to March');
  });

  it('a period is always 12 months', async () => {
    const res = await consultant.a.post(api(`/installations/${instB}/periods`), { startDate: '2026-01-01', endDate: '2026-06-30' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues[0].message).toBe('A reporting period is 12 months: it ends on 2026-12-31.');
  });

  it('the database refuses a short period and a missing justification too', async () => {
    const insert = (start: string, end: string, justification: string | null) =>
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx
          .insertInto('reporting_period')
          .values({ tenant_id: admin.tenantId, client_id: clientId, installation_id: instB, start_date: start, end_date: end, justification } as never)
          .execute(),
      );
    await expect(insert('2030-01-01', '2030-06-30', null)).rejects.toMatchObject({ constraint: 'reporting_period_twelve_months' });
    await expect(insert('2030-04-01', '2031-03-31', null)).rejects.toMatchObject({ constraint: 'reporting_period_justified' });
    await expect(insert('2030-04-01', '2031-03-31', '   ')).rejects.toMatchObject({ constraint: 'reporting_period_justified' });
  });

  it('a date edit and "Submit for review" at the same time cannot both succeed (independent review M3 F1)', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    // T1 edits the dates and holds its transaction open; T2 submits meanwhile.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let edited!: () => void;
    const didEdit = new Promise<void>((r) => (edited = r));
    const t1 = withContext(t.db, ctxOf(consultant, 'consultant'), async (tx) => {
      await tx
        .updateTable('reporting_period')
        .set({ start_date: '2027-01-01', end_date: '2027-12-31' })
        .where('id', '=', p.id)
        .execute();
      edited();
      await held;
    });
    await didEdit;
    let submitted = false;
    const t2 = move(consultant.a, v, 'submit').then((r) => {
      submitted = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(submitted, 'the submit must wait for the date edit').toBe(false);
    release();
    await t1;
    expect((await t2).status).toBe(200);
    // The submit came after the edit, so the new dates were made while still a draft.
    const detail = (await consultant.a.get(api(`/periods/${p.id}`))).body.period;
    expect([detail.startDate, detail.versions[0].status]).toEqual(['2027-01-01', 'in_review']);
    // Once submitted, the dates can no longer change.
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('reporting_period').set({ start_date: '2028-01-01', end_date: '2028-12-31' }).where('id', '=', p.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('a 29 February start ends on 28 February (independent review M3 F4)', async () => {
    const p = await openPeriod(await newInstallation(), { startDate: '2028-02-29', endDate: '2029-02-28', justification: 'Plant commissioned 29 Feb' });
    expect((await consultant.a.get(api(`/periods/${p.id}`))).body.period.endDate).toBe('2029-02-28');
    const short = await consultant.a.post(api(`/installations/${instB}/periods`), { startDate: '2032-02-29', endDate: '2033-02-27', justification: 'x' });
    expect(short.status).toBe(400);
  });

  it('the database refuses a period on a deleted installation (independent review M3 F7)', async () => {
    const inst = await newInstallation();
    expect((await consultant.a.delete(api(`/installations/${inst}`))).status).toBe(204);
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx
          .insertInto('reporting_period')
          .values({ tenant_id: admin.tenantId, client_id: clientId, installation_id: inst, start_date: '2026-01-01', end_date: '2026-12-31' } as never)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('start dates outside 2023–2100 are a 400 with a field message, never a 500 (review M3 F2)', async () => {
    for (const body of [
      { startDate: '0050-01-01', endDate: '0050-12-31' },
      { startDate: '0050-01-01', endDate: '1950-12-31' },
      cal(1950),
      cal(2101),
    ]) {
      const res = await consultant.a.post(api(`/installations/${instB}/periods`), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.issues).toEqual([{ path: ['startDate'], message: 'Choose a start date between 2023 and 2100.' }]);
    }
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx
          .insertInto('reporting_period')
          .values({ tenant_id: admin.tenantId, client_id: clientId, installation_id: instB, start_date: '1950-01-01', end_date: '1950-12-31' } as never)
          .execute(),
      ),
    ).rejects.toMatchObject({ constraint: 'reporting_period_range' });
  });

  it('dates can be corrected while version 1 is a draft, and not after', async () => {
    const p = await openPeriod(await newInstallation());
    const fix = await consultant.a.patch(api(`/periods/${p.id}`), { startDate: '2026-04-01', endDate: '2027-03-31', justification: 'Financial year' });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect(fix.body.period).toMatchObject({ startDate: '2026-04-01', endDate: '2027-03-31' });
    await move(consultant.a, p.versions[0]!.id, 'submit');
    const late = await consultant.a.patch(api(`/periods/${p.id}`), cal(2026));
    expect(late.status).toBe(409);
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('reporting_period').set({ justification: 'changed' }).where('id', '=', p.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

describe('M3-R3 status machine', () => {
  it('draft → in review → approved → issued, each step in the history with who did it', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    const issued = await issue(v);
    expect(issued.versions[0]).toMatchObject({ status: 'issued' });
    expect(issued.versions[0].approvedAt).toBeTruthy();
    expect(issued.versions[0].issuedAt).toBeTruthy();
    expect(
      issued.history.map((h: { fromStatus: string | null; toStatus: string; changedBy: string }) => [h.fromStatus, h.toStatus, h.changedBy]).reverse(),
    ).toEqual([
      [null, 'draft', 'Cara Consultant'],
      ['draft', 'in_review', 'Cara Consultant'],
      ['in_review', 'approved', 'Rhea Reviewer'],
      ['approved', 'issued', 'Cara Consultant'],
    ]);
  });

  it('no skipping steps', async () => {
    const p = await openPeriod(await newInstallation());
    const res = await move(consultant.a, p.versions[0]!.id, 'issue');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'invalid_transition', message: "This period is a draft, so you can't issue period now." });
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('period_version').set({ status: 'approved' }).where('id', '=', p.versions[0]!.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('forward steps by role: reviewers approve but do not submit or issue; contributors change nothing', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    expect((await move(reviewer.a, v, 'submit')).status).toBe(403);
    expect((await move(contributor.a, v, 'submit')).status).toBe(403);
    await move(consultant.a, v, 'submit');
    expect((await move(contributor.a, v, 'approve')).status).toBe(403);
    await move(reviewer.a, v, 'approve');
    expect((await move(reviewer.a, v, 'issue')).status).toBe(403);
    // The database checks the role too.
    await expect(
      withContext(t.db, ctxOf(reviewer, 'reviewer'), (tx) => tx.updateTable('period_version').set({ status: 'issued' }).where('id', '=', v).execute()),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('back to draft: only a consultant, only with a reason, and the reason is logged', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    await move(consultant.a, v, 'submit');
    await move(reviewer.a, v, 'approve');

    expect((await move(reviewer.a, v, 'reopen', 'Numbers look wrong')).status).toBe(403);
    const byAdmin = await move(admin.a, v, 'reopen', 'Numbers look wrong');
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.message).toBe('Only a consultant can return a period to draft.');
    const noReason = await move(consultant.a, v, 'reopen');
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.issues).toEqual([{ path: ['reason'], message: 'Say why this period goes back to draft.' }]);

    const res = await move(consultant.a, v, 'reopen', 'Gas meter reading for March was wrong');
    expect(res.status).toBe(200);
    expect(res.body.period.versions[0]).toMatchObject({ status: 'draft', approvedAt: null });
    expect(res.body.period.history[0]).toMatchObject({ fromStatus: 'approved', toStatus: 'draft', reason: 'Gas meter reading for March was wrong' });

    const { rows } = await sql<{ action: string; reason: string; changed_fields: string[] }>`
      select action, reason, changed_fields from audit.audit_log
       where table_name = 'public.period_version' and record_id = ${v} order by id desc limit 1`.execute(t.su);
    expect(rows[0]).toEqual({ action: 'Return to draft', reason: 'Gas meter reading for March was wrong', changed_fields: ['approved_at', 'approved_by', 'status'] });
  });

  it('the database refuses back-transitions without a reason or by another role', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    await move(consultant.a, v, 'submit');
    const reopen = (ctx: RequestContext) =>
      withContext(t.db, ctx, (tx) => tx.updateTable('period_version').set({ status: 'draft' }).where('id', '=', v).execute());
    await expect(reopen(ctxOf(consultant, 'consultant'))).rejects.toMatchObject({ code: '23514' });
    await expect(reopen(ctxOf({ id: admin.adminId }, 'platform_admin', { reason: 'x' }))).rejects.toMatchObject({ code: '42501' });
    await expect(reopen(ctxOf(consultant, 'consultant', { reason: 'Fix a typo' }))).resolves.toBeDefined();
  });

  it('no role can write status history directly; only a real status change does (review M3 F1)', async () => {
    const p = await openPeriod(instA, cal(2033));
    const v = p.versions[0]!.id;
    const forge = (u: { id: string }, role: UserRole) =>
      withContext(t.db, ctxOf(u, role), (tx) =>
        tx
          .insertInto('period_status_change')
          .values({ tenant_id: admin.tenantId, client_id: clientId, installation_id: instA, period_version_id: v, from_status: 'in_review', to_status: 'approved', reason: 'forged' } as never)
          .execute(),
      );
    for (const [u, role] of [[contributor, 'contributor'], [consultant, 'consultant'], [{ id: admin.adminId }, 'platform_admin']] as const) {
      await expect(forge(u, role), role).rejects.toMatchObject({ code: '42501' });
    }
    // Status changes through the API (including by a reviewer) still write history.
    await move(consultant.a, v, 'submit');
    const res = await move(reviewer.a, v, 'approve');
    expect(res.body.period.history.map((h: { toStatus: string; changedBy: string }) => [h.toStatus, h.changedBy])).toEqual([
      ['approved', 'Rhea Reviewer'],
      ['in_review', 'Cara Consultant'],
      ['draft', 'Cara Consultant'],
    ]);
  });

  it('the status history is append-only', async () => {
    const p = await openPeriod(await newInstallation());
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('period_status_change').set({ reason: 'rewritten' }).where('period_version_id', '=', p.versions[0]!.id).execute(),
      ),
    ).rejects.toThrow();
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.deleteFrom('period_status_change').where('period_version_id', '=', p.versions[0]!.id).execute(),
      ),
    ).rejects.toThrow();
  });
});

describe('M3-R4 approved and issued periods are read-only (G4)', () => {
  // Stand-in for the period tables that M5–M9 add: a table registered the way they will be.
  beforeAll(async () => {
    await sql`
      create table public.m3_test_period_data (
        id uuid primary key default gen_random_uuid(),
        period_version_id uuid not null references period_version (id),
        value text
      )`.execute(t.owner);
    await sql`select app.register_period_table('public.m3_test_period_data')`.execute(t.owner);
    await sql`grant select, insert, update, delete on public.m3_test_period_data to cbam_app`.execute(t.owner);
  });
  afterAll(async () => {
    await sql`drop table public.m3_test_period_data`.execute(t.owner);
  });

  const write = (u: { id: string }, role: UserRole, versionId: string) =>
    withContext(t.db, ctxOf(u, role), (tx) =>
      sql`insert into public.m3_test_period_data (period_version_id, value) values (${versionId}, 'x')`.execute(tx),
    );

  it('AT2: writes to period data fail in the database once approved, and after issue', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    await write(consultant, 'consultant', v); // draft: fine
    await move(consultant.a, v, 'submit');
    await write(consultant, 'consultant', v); // in review: still editable (findings get fixed)
    await move(reviewer.a, v, 'approve');
    await expect(write(consultant, 'consultant', v)).rejects.toMatchObject({ code: '55000' });
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) => sql`update public.m3_test_period_data set value = 'y' where period_version_id = ${v}`.execute(tx)),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) => sql`delete from public.m3_test_period_data where period_version_id = ${v}`.execute(tx)),
    ).rejects.toMatchObject({ code: '55000' });
    await move(consultant.a, v, 'issue');
    await expect(write(consultant, 'consultant', v)).rejects.toMatchObject({ code: '55000' });
  });

  it('the lock check works for data contributors, who cannot update the version row', async () => {
    const p = await openPeriod(instA, cal(2031));
    const v = p.versions[0]!.id;
    await write(contributor, 'contributor', v);
    await move(consultant.a, v, 'submit');
    await move(reviewer.a, v, 'approve');
    await expect(write(contributor, 'contributor', v)).rejects.toMatchObject({ code: '55000' });
  });

  it('the API check answers 409 with the next step, and 404 for a version the caller cannot see', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    await expect(withContext(t.db, ctxOf(consultant, 'consultant'), (tx) => assertPeriodWritable(tx, v))).resolves.toBeUndefined();
    await issue(v);
    await expect(withContext(t.db, ctxOf(consultant, 'consultant'), (tx) => assertPeriodWritable(tx, v))).rejects.toMatchObject({
      status: 409,
      message: 'This period is issued and read-only. Create a new version to make changes.',
    });
    await expect(withContext(t.db, ctxOf(outsider, 'consultant'), (tx) => assertPeriodWritable(tx, v))).rejects.toMatchObject({ status: 404 });
  });

  it('the lock check reveals nothing about versions the caller cannot see (independent review M3 F6)', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    await issue(v);
    const otherTenant = await adminOfNewTenant(t);
    const check = (id: string) =>
      withContext(t.db, { tenantId: otherTenant.tenantId, userId: otherTenant.adminId, userRole: 'platform_admin', requestId: randomUUID() }, (tx) =>
        sql`select app.assert_period_writable(${id})`.execute(tx),
      ).then(
        () => 'ok',
        (e: { code: string }) => e.code,
      );
    expect(await check(v)).toBe('23503');
    expect(await check(randomUUID())).toBe('23503');
    // Same tenant, not on the client: also nothing.
    const outsiderCheck = await withContext(t.db, ctxOf(outsider, 'consultant'), (tx) => sql`select app.assert_period_writable(${v})`.execute(tx)).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    expect(outsiderCheck).toBe('23503');
  });

  it('an approved version row itself cannot change except by a status step', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    await move(consultant.a, v, 'submit');
    await move(reviewer.a, v, 'approve');
    const current = await withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
      tx.selectFrom('period_version').select('template_version_id').where('id', '=', v).executeTakeFirstOrThrow(),
    );
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('period_version').set({ template_version_id: current.template_version_id, issued_at: new Date() }).where('id', '=', v).execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

describe('M3-R5 changes after issue go into version n+1', () => {
  it('a new version needs the previous one issued', async () => {
    const p = await openPeriod(await newInstallation());
    const res = await consultant.a.post(api(`/periods/${p.id}/versions`));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Version 1 is a draft. Make changes there; a new version is needed only after issue.');
  });

  it('version 2 starts as a draft with version 1’s pins; version 1 stays issued and unchanged', async () => {
    const p = await openPeriod(await newInstallation());
    const v1 = p.versions[0]!.id;
    const before = (await issue(v1)).versions[0];
    const res = await consultant.a.post(api(`/periods/${p.id}/versions`));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [v2, v1After] = res.body.period.versions;
    expect(v2).toMatchObject({ versionNo: 2, status: 'draft', basedOnVersionNo: 1, libraryVersion: before.libraryVersion, templateVersion: before.templateVersion });
    expect(v1After).toEqual(before);
    expect(res.body.period.datesEditable).toBe(false);

    // Version 1 can no longer move in any direction.
    const again = await move(consultant.a, v1, 'reopen', 'try');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('locked');
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant', { reason: 'x' }), (tx) =>
        tx.updateTable('period_version').set({ status: 'draft' }).where('id', '=', v1).execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });

    // And there is only one working version at a time.
    expect((await consultant.a.post(api(`/periods/${p.id}/versions`))).status).toBe(409);
  });

  it('concurrent "create new version" requests make exactly one', async () => {
    const p = await openPeriod(await newInstallation());
    await issue(p.versions[0]!.id);
    const results = await Promise.all([1, 2, 3].map(() => consultant.a.post(api(`/periods/${p.id}/versions`))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('version n+1 must be based on version n of the same period (review M3 F4)', async () => {
    const p = await openPeriod(await newInstallation());
    const other = await openPeriod(await newInstallation());
    const v1 = p.versions[0]!.id;
    await issue(v1);
    const pins = await withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
      tx.selectFrom('period_version').select(['library_version_id', 'template_version_id']).where('id', '=', v1).executeTakeFirstOrThrow(),
    );
    const insertV2 = (basedOn: string | null) =>
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx
          .insertInto('period_version')
          .values({ tenant_id: admin.tenantId, client_id: clientId, installation_id: p.installationId, period_id: p.id, version_no: 2, based_on_version_id: basedOn, ...pins } as never)
          .execute(),
      );
    await expect(insertV2(other.versions[0]!.id)).rejects.toMatchObject({ code: '23514' });
    await expect(insertV2(null)).rejects.toMatchObject({ code: '23514' });
    await expect(insertV2(v1)).resolves.toBeDefined();
  });

  it('pins: version n+1 keeps version n’s, and only admins and consultants change a draft’s (independent review M3 F2)', async () => {
    // A second, older template, so it never becomes the one new periods pin.
    const other = await t.su.transaction().execute(async (tx) => {
      await sql`select set_config('app.user_id', ${admin.adminId}, true)`.execute(tx);
      const { rows } = await sql<{ id: string }>`
        insert into template_version (code, title, file_name, file_sha256, released_on, source)
        values (${`test-${randomUUID().slice(0, 8)}`}, 'Test template', 'test.xlsx', ${'0'.repeat(64)}, '2000-01-01', 'M3 test')
        returning id`.execute(tx);
      return rows[0]!.id;
    });

    const draft = await openPeriod(await newInstallation());
    const repin = (u: { id: string }, role: UserRole) =>
      withContext(t.db, ctxOf(u, role), (tx) =>
        tx.updateTable('period_version').set({ template_version_id: other }).where('id', '=', draft.versions[0]!.id).execute(),
      );
    await expect(repin(reviewer, 'reviewer')).rejects.toMatchObject({ code: '42501' });

    const p = await openPeriod(await newInstallation());
    const v1 = p.versions[0]!.id;
    await issue(v1);
    const pins = await withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
      tx.selectFrom('period_version').select(['library_version_id', 'template_version_id']).where('id', '=', v1).executeTakeFirstOrThrow(),
    );
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx
          .insertInto('period_version')
          .values({ tenant_id: admin.tenantId, client_id: clientId, installation_id: p.installationId, period_id: p.id, version_no: 2, based_on_version_id: v1, ...pins, template_version_id: other } as never)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('versions cannot be deleted', async () => {
    const p = await openPeriod(await newInstallation());
    await expect(
      withContext(t.db, ctxOf({ id: admin.adminId }, 'platform_admin'), (tx) => tx.deleteFrom('period_version').where('id', '=', p.versions[0]!.id).execute()),
    ).rejects.toThrow();
  });
});

describe('M3-R6 clone', () => {
  it('AT3 (partial until M5): clone 2026 → 2027 makes a new draft period on the same installation', async () => {
    const inst = await newInstallation();
    const p2026 = await openPeriod(inst);
    await issue(p2026.versions[0]!.id);
    const res = await consultant.a.post(api(`/periods/${p2026.id}/clone`), cal(2027));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.period).toMatchObject({ installationId: inst, startDate: '2027-01-01', endDate: '2027-12-31', versionCount: 1 });
    expect(res.body.period.versions[0]).toMatchObject({ versionNo: 1, status: 'draft' });
    const list = (await consultant.a.get(api(`/installations/${inst}/periods`))).body.periods;
    expect(list.map((x: { startDate: string }) => x.startDate)).toEqual(['2027-01-01', '2026-01-01']);
  });

  it('a clone may not overlap', async () => {
    const inst = await newInstallation();
    const p = await openPeriod(inst);
    expect((await consultant.a.post(api(`/periods/${p.id}/clone`), cal(2026))).status).toBe(409);
  });
});

describe('M3-R7 approval is blocked while M11 reports open critical issues', () => {
  it('the approval guard stops approval and names the rule', async () => {
    const p = await openPeriod(await newInstallation());
    const v = p.versions[0]!.id;
    await move(consultant.a, v, 'submit');
    blocked.add(v);
    const res = await move(reviewer.a, v, 'approve');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'approval_blocked', message: "You can't approve this period: 2 blocking issues are open." });
    blocked.delete(v);
    expect((await move(reviewer.a, v, 'approve')).status).toBe(200);
  });
});

describe('M3-R8 dates are dates', () => {
  it('stored as date and returned as the same YYYY-MM-DD strings', async () => {
    const p = await openPeriod(await newInstallation(), { startDate: '2026-04-01', endDate: '2027-03-31', justification: 'Financial year' });
    const { rows } = await sql<{ type: string }>`
      select pg_typeof(start_date)::text as type from reporting_period where id = ${p.id}`.execute(t.su);
    expect(rows[0]!.type).toBe('date');
    const detail = (await consultant.a.get(api(`/periods/${p.id}`))).body.period;
    expect([detail.startDate, detail.endDate]).toEqual(['2026-04-01', '2027-03-31']);
  });
});

describe('access (G1, G2)', () => {
  let periodA: string;
  let periodB: string;
  beforeAll(async () => {
    periodA = (await openPeriod(instA, cal(2026))).id;
    periodB = (await openPeriod(instB, cal(2026))).id;
  });

  it('a consultant not on the client sees nothing', async () => {
    expect((await outsider.a.get(api(`/periods/${periodA}`))).status).toBe(404);
    expect((await outsider.a.get(api(`/installations/${instA}/periods`))).status).toBe(404);
    expect((await outsider.a.post(api(`/installations/${instA}/periods`), cal(2040))).status).toBe(404);
  });

  it('a contributor sees periods of assigned installations only, and cannot open one', async () => {
    expect((await contributor.a.get(api(`/periods/${periodA}`))).status).toBe(200);
    expect((await contributor.a.get(api(`/periods/${periodB}`))).status).toBe(404);
    expect((await contributor.a.post(api(`/installations/${instA}/periods`), cal(2041))).status).toBe(403);
  });

  it('a reviewer reads but does not open, clone or re-version periods', async () => {
    expect((await reviewer.a.get(api(`/periods/${periodB}`))).status).toBe(200);
    expect((await reviewer.a.post(api(`/installations/${instB}/periods`), cal(2042))).status).toBe(403);
    expect((await reviewer.a.post(api(`/periods/${periodB}/clone`), cal(2043))).status).toBe(403);
    expect((await reviewer.a.post(api(`/periods/${periodB}/versions`))).status).toBe(403);
  });

  it('RLS refuses a reviewer who writes directly', async () => {
    await expect(
      withContext(t.db, ctxOf(reviewer, 'reviewer'), (tx) =>
        tx
          .insertInto('reporting_period')
          .values({ tenant_id: admin.tenantId, client_id: clientId, installation_id: instB, ...{ start_date: '2044-01-01', end_date: '2044-12-31' } } as never)
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('audit (G3)', () => {
  it('opening a period and each status step are logged with the business verb', async () => {
    const p = await openPeriod(await newInstallation());
    await move(consultant.a, p.versions[0]!.id, 'submit');
    const { rows } = await sql<{ table_name: string; action: string; op: string }>`
      select table_name, action, op from audit.audit_log
       where record_id in (${p.id}, ${p.versions[0]!.id}) order by id`.execute(t.su);
    expect(rows).toEqual([
      { table_name: 'public.reporting_period', action: 'Open reporting period', op: 'INSERT' },
      { table_name: 'public.period_version', action: 'Open reporting period', op: 'INSERT' },
      { table_name: 'public.period_version', action: 'Submit for review', op: 'UPDATE' },
    ]);
  });
});

describe('M2 AT3: an installation with a period cannot be deleted', () => {
  it('the API blocks it with a clear message, and the database refuses too', async () => {
    const inst = await newInstallation();
    await openPeriod(inst);
    const res = await consultant.a.delete(api(`/installations/${inst}`));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'has_periods' });
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('installation').set({ deleted_at: new Date() }).where('id', '=', inst).execute(),
      ),
    ).rejects.toMatchObject({ code: '23001' });
    expect((await consultant.a.delete(api(`/installations/${await newInstallation()}`))).status).toBe(204);
  });
});

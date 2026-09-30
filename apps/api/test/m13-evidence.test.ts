import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@cbam/shared';
import { type RequestContext, withContext } from '../src/platform/db';
import { WEB_ORIGIN, type TestAgent, adminOfNewTenant, inviteAndAccept, signIn, signInWithMfa, testApp } from './helpers';

// M13 — Evidence and audit.
// Requirement IDs from .claude/skills/cbam-module-reviewer/references/modules/M13-evidence-audit.md
// (AT3, an NCV edit in the audit trail, is in m04-reference.test.ts: it needs the library's
// operator tenant, which that file owns.)

const t = testApp();

type User = { a: TestAgent; id: string; email: string };
let admin: Awaited<ReturnType<typeof adminOfNewTenant>>;
let consultant: User;
let reviewer: User;
let contributor: User;
let recipient: User;
let outsider: User; // consultant on another client
let clientId: string;
let otherClientId: string;
let instA: string; // contributor assigned
let instB: string;

const api = (path: string) => `/api/v1${path}`;

const PDF = (text: string = randomUUID()) => Buffer.from(`%PDF-1.7\n${text}\n%%EOF`);
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
// A real workbook: the official template (read only, never changed).
const TEMPLATE = () => readFileSync(resolve(import.meta.dirname, '../../../templates/CBAM_Communication_Template_Installations_2026-Q2.xlsx'));

/** A minimal stored (uncompressed) ZIP with a central directory, for crafted archives. */
function zip(entries: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
const SHEET_TYPES = '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
const CSV = () => Buffer.from(`date,reading\n2026-01-31,${Math.random()}\n`);

/** Raw-body upload, as the web client sends it. */
function uploadAs(who: User, target: string, body: Buffer, query: Record<string, string>) {
  return who.a.raw
    .post(api(`/clients/${target}/evidence`))
    .query(query)
    .set('Origin', WEB_ORIGIN)
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

async function upload(who: User, query: Record<string, string> = {}, body: Buffer = PDF(), target = clientId) {
  const res = await uploadAs(who, target, body, { fileName: 'meter-reading.pdf', docType: 'meter_reading', ...query });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.evidence as { id: string; links: { id: string; recordType: string; recordId: string; label: string; locked: boolean }[]; locked: boolean };
}

const ctxOf = (u: { id: string }, role: UserRole): RequestContext => ({ tenantId: admin.tenantId, userId: u.id, userRole: role, requestId: randomUUID() });

async function newClient(who: TestAgent) {
  const res = await who.post(api('/clients'), {
    legalName: `Aurum Metals ${randomUUID().slice(0, 6)}`,
    addressLine1: '12 Marine Drive',
    city: 'Mumbai',
    countryCode: 'IN',
    contactName: 'Ravi Mehta',
    contactEmail: 'ravi@aurum.example',
  });
  expect(res.status).toBe(201);
  return res.body.client.id as string;
}

async function newInstallation(client = clientId) {
  const res = await consultant.a.post(api(`/clients/${client}/installations`), { nameEn: `Smelter ${randomUUID().slice(0, 6)}`, street: 's', city: 'c', countryCode: 'IN' });
  expect(res.status).toBe(201);
  return res.body.installation.id as string;
}

let nextYear = 2026;
async function openPeriod(installationId: string) {
  const y = nextYear++;
  const res = await consultant.a.post(api(`/installations/${installationId}/periods`), { startDate: `${y}-01-01`, endDate: `${y}-12-31` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.period as { id: string; installationId: string; versions: { id: string }[] };
}

const move = (who: TestAgent, versionId: string, action: string) => who.post(api(`/period-versions/${versionId}/transitions`), { action });
async function approve(versionId: string) {
  expect((await move(consultant.a, versionId, 'submit')).status).toBe(200);
  expect((await move(reviewer.a, versionId, 'approve')).status).toBe(200);
}

beforeAll(async () => {
  admin = await adminOfNewTenant(t);
  const invite = async (role: UserRole, name: string, mfa: boolean) => {
    const u = await inviteAndAccept(t, admin.a, role, name);
    return { ...u, a: mfa ? (await signInWithMfa(t, u.email)).a : (await signIn(t, u.email)).a };
  };
  consultant = await invite('consultant', 'Cara Consultant', true);
  outsider = await invite('consultant', 'Otto Outsider', true);
  reviewer = await invite('reviewer', 'Rhea Reviewer', false);
  contributor = await invite('contributor', 'Kiran Contributor', false);
  recipient = await invite('recipient', 'Rita Recipient', false);

  clientId = await newClient(consultant.a);
  otherClientId = await newClient(outsider.a);
  instA = await newInstallation();
  instB = await newInstallation();
  expect((await admin.a.put(api(`/clients/${clientId}/team/${reviewer.id}`))).status).toBe(204);
  expect((await admin.a.put(api(`/clients/${clientId}/team/${recipient.id}`))).status).toBe(204);
  expect((await admin.a.put(api(`/installations/${instA}/team/${contributor.id}`))).status).toBe(204);
});

afterAll(() => t.close());

// ---------------------------------------------------------------------------

describe('M13-R1 evidence on any record; one file supports many records', () => {
  it('uploads, links to several records and lists them with labels', async () => {
    const p = await openPeriod(instA);
    const ev = await upload(consultant, { recordType: 'installation', recordId: instA, installationId: instA, title: 'Gas meter, January' });
    expect(ev.links).toMatchObject([{ recordType: 'installation', recordId: instA, label: expect.stringMatching(/^Installation: Smelter/) }]);

    const linked = await consultant.a.post(api(`/evidence/${ev.id}/links`), { recordType: 'period_version', recordId: p.versions[0]!.id });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(linked.body.evidence.links.map((l: { recordType: string }) => l.recordType)).toEqual(['installation', 'period_version']);
    expect(linked.body.evidence.links[1].label).toMatch(/^Reporting period: Smelter .* 20\d\d, version 1$/);

    const forRecord = await consultant.a.get(api(`/records/period_version/${p.versions[0]!.id}/evidence`));
    expect(forRecord.body.evidence.map((e: { id: string }) => e.id)).toEqual([ev.id]);
    // Linking twice is refused, not duplicated.
    expect((await consultant.a.post(api(`/evidence/${ev.id}/links`), { recordType: 'period_version', recordId: p.versions[0]!.id })).status).toBe(409);
  });

  it('a record of another client, an invisible record or a missing record cannot be linked', async () => {
    const ev = await upload(consultant);
    expect((await consultant.a.post(api(`/evidence/${ev.id}/links`), { recordType: 'client', recordId: otherClientId })).status).toBe(404);
    expect((await consultant.a.post(api(`/evidence/${ev.id}/links`), { recordType: 'installation', recordId: randomUUID() })).status).toBe(404);
    // The database refuses a cross-client link even when the record is visible (admin sees both).
    const adminLink = await admin.a.post(api(`/evidence/${ev.id}/links`), { recordType: 'client', recordId: otherClientId });
    expect(adminLink.status).toBe(409);
    expect(adminLink.body.error.code).toBe('wrong_client');
    await expect(
      withContext(t.db, ctxOf({ id: admin.adminId }, 'platform_admin'), (tx) =>
        tx.insertInto('evidence_link').values({ tenant_id: admin.tenantId, client_id: clientId, evidence_id: ev.id, record_table: 'client', record_id: otherClientId } as never).execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a file filed under one installation cannot support another installation’s records', async () => {
    const ev = await upload(consultant, { installationId: instA });
    const res = await consultant.a.post(api(`/evidence/${ev.id}/links`), { recordType: 'installation', recordId: instB });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('wrong_installation');
  });

  it('contributors remove only the links they made (review M13 F3)', async () => {
    const p = await openPeriod(instA);
    const v = p.versions[0]!.id;
    const byConsultant = await upload(consultant, { installationId: instA, recordType: 'period_version', recordId: v });
    // Contributors may link a file they can see (D15)…
    const linked = await contributor.a.post(api(`/evidence/${byConsultant.id}/links`), { recordType: 'installation', recordId: instA });
    expect(linked.status).toBe(201);
    const links = linked.body.evidence.links as { id: string; recordType: string; createdById: string }[];
    const consultantsLink = links.find((l) => l.recordType === 'period_version')!;
    const ownLink = links.find((l) => l.recordType === 'installation')!;
    expect(ownLink.createdById).toBe(contributor.id);
    // …but not remove the consultant's link, through the API or directly.
    const res = await contributor.a.delete(api(`/evidence/${byConsultant.id}/links/${consultantsLink.id}`));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('You can remove only the links you made.');
    const direct = await withContext(t.db, ctxOf(contributor, 'contributor'), (tx) =>
      tx.deleteFrom('evidence_link').where('id', '=', consultantsLink.id).executeTakeFirst(),
    );
    expect(Number(direct.numDeletedRows)).toBe(0);
    expect((await contributor.a.delete(api(`/evidence/${byConsultant.id}/links/${ownLink.id}`))).status).toBe(204);
    expect((await consultant.a.delete(api(`/evidence/${byConsultant.id}/links/${consultantsLink.id}`))).status).toBe(204);
  });

  it('the database refuses links to evidence the caller cannot see, deleted evidence, and unconfigured tables (review M13 F4)', async () => {
    const p = await openPeriod(instA);
    const v = p.versions[0]!.id;
    const clientLevel = await upload(consultant); // invisible to the contributor
    const deletedB = await upload(consultant, { installationId: instB });
    await consultant.a.delete(api(`/evidence/${deletedB.id}`));
    const insert = (u: { id: string }, role: UserRole, evidenceId: string, table = 'period_version', recordId = v) =>
      withContext(t.db, ctxOf(u, role), (tx) =>
        tx
          .insertInto('evidence_link')
          .values({ tenant_id: admin.tenantId, client_id: clientId, evidence_id: evidenceId, record_table: table, record_id: recordId } as never)
          .execute(),
      );
    await expect(insert(contributor, 'contributor', clientLevel.id)).rejects.toMatchObject({ code: '23503' });
    await expect(insert(consultant, 'consultant', deletedB.id)).rejects.toMatchObject({ code: '23503' });
    await expect(insert(consultant, 'consultant', clientLevel.id, 'app_user', consultant.id)).rejects.toMatchObject({
      code: '23514',
      message: 'Evidence cannot be linked to app_user',
    });
  });

  it('link columns come from the record, not the request', async () => {
    const p = await openPeriod(instB);
    const ev = await upload(consultant);
    await withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
      tx
        .insertInto('evidence_link')
        .values({
          tenant_id: admin.tenantId, client_id: clientId, evidence_id: ev.id, record_table: 'period_version', record_id: p.versions[0]!.id,
          installation_id: instA, period_version_id: null,
        } as never)
        .execute(),
    );
    const { rows } = await sql<{ installation_id: string; period_version_id: string }>`
      select installation_id, period_version_id from evidence_link where evidence_id = ${ev.id}`.execute(t.su);
    expect(rows[0]).toEqual({ installation_id: instB, period_version_id: p.versions[0]!.id });
  });
});

describe('M13-R2 private files, short-lived signed links, G1/G2', () => {
  it('stores the file privately under tenant/client and returns a 5-minute link', async () => {
    const body = PDF('lab report');
    const ev = await upload(consultant, { fileName: 'Lab Report.PDF', docType: 'lab_report' }, body);
    const key = [...t.files.files.keys()].find((k) => t.files.files.get(k)!.equals(body))!;
    expect(key).toMatch(new RegExp(`^${admin.tenantId}/${clientId}/evidence/[0-9a-f-]{36}\\.pdf$`));

    const now = Date.now();
    const res = await consultant.a.get(api(`/evidence/${ev.id}/download`));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const expires = Number(new URL(res.body.url).searchParams.get('expires'));
    expect(expires * 1000 - now).toBeGreaterThan(299_000);
    expect(expires * 1000 - now).toBeLessThanOrEqual(301_000);
    expect(Date.parse(res.body.expiresAt) - now).toBeLessThanOrEqual(301_000);
  });

  it('AT1: a link used after it expires is refused (memory store; Cloudinary enforces expires_at the same way)', async () => {
    const ev = await upload(consultant);
    const { url } = (await consultant.a.get(api(`/evidence/${ev.id}/download`))).body;
    expect(t.files.open(url)).toBeInstanceOf(Buffer);
    vi.useFakeTimers({ now: Date.now() + 301_000 });
    try {
      expect(() => t.files.open(url)).toThrow(/expired/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('other clients, other tenants and recipients get nothing; contributors only their installations', async () => {
    const clientLevel = await upload(consultant, { docType: 'contract', fileName: 'contract.pdf' });
    const siteA = await upload(consultant, { installationId: instA });
    const siteB = await upload(consultant, { installationId: instB });

    expect((await outsider.a.get(api(`/evidence/${clientLevel.id}`))).status).toBe(404);
    expect((await outsider.a.get(api(`/evidence/${clientLevel.id}/download`))).status).toBe(404);
    expect((await outsider.a.get(api(`/clients/${clientId}/evidence`))).status).toBe(404);

    const other = await adminOfNewTenant(t);
    expect((await other.a.get(api(`/evidence/${clientLevel.id}/download`))).status).toBe(404);

    expect((await recipient.a.get(api(`/evidence/${clientLevel.id}`))).status).toBe(404);
    expect((await recipient.a.get(api(`/clients/${clientId}/evidence`))).body.evidence).toEqual([]);

    const seen = (await contributor.a.get(api(`/clients/${clientId}/evidence`))).body.evidence.map((e: { id: string }) => e.id);
    expect(seen).toContain(siteA.id);
    expect(seen).not.toContain(siteB.id);
    expect(seen).not.toContain(clientLevel.id);
    expect((await reviewer.a.get(api(`/evidence/${siteB.id}`))).status).toBe(200);
  });

  it('contributors upload to their installation only; reviewers and recipients do not upload', async () => {
    const ok = await upload(contributor, { installationId: instA, recordType: 'installation', recordId: instA });
    expect(ok.links).toHaveLength(1);
    const noSite = await uploadAs(contributor, clientId, PDF(), { fileName: 'a.pdf', docType: 'other' });
    expect(noSite.status).toBe(400);
    expect(noSite.body.error.message).toBe('Choose the installation this file belongs to.');
    expect((await uploadAs(contributor, clientId, PDF(), { fileName: 'a.pdf', docType: 'other', installationId: instB })).status).toBe(404);
    expect((await uploadAs(reviewer, clientId, PDF(), { fileName: 'a.pdf', docType: 'other' })).status).toBe(403);
    expect((await uploadAs(recipient, clientId, PDF(), { fileName: 'a.pdf', docType: 'other' })).status).toBe(403);
    // A contributor cannot link a client-level record.
    expect((await contributor.a.post(api(`/evidence/${ok.id}/links`), { recordType: 'client', recordId: clientId })).status).toBe(403);
  });
});

describe('M13-R3 type and size limits, content check', () => {
  const refused = async (fileName: string, body: Buffer) => {
    const res = await uploadAs(consultant, clientId, body, { fileName, docType: 'other' });
    return [res.status, res.body.error?.message];
  };

  it('accepts PDF, PNG, XLSX and CSV whose bytes match their name', async () => {
    await upload(consultant, { fileName: 'site.png', docType: 'photo' }, PNG());
    await upload(consultant, { fileName: 'template.xlsx' }, TEMPLATE());
    const csv = await upload(consultant, { fileName: 'readings.csv' }, CSV());
    expect((await consultant.a.get(api(`/evidence/${(csv as { id: string }).id}`))).body.evidence.contentType).toBe('text/csv');
  });

  it('refuses other types, disguised files, empty and oversized files, with the reason', async () => {
    expect(await refused('setup.exe', Buffer.from('MZ\u0090\u0000'))).toEqual([400, 'Only PDF, PNG, JPEG, XLSX and CSV files are accepted.']);
    expect(await refused('invoice.pdf', Buffer.from('MZ\u0090\u0000binary'))).toEqual([400, 'This file is not a real PDF file. Export it again from the program that made it.']);
    expect((await refused('photo.png', PDF()))[0]).toBe(400);
    expect((await refused('book.xlsx', Buffer.from('PK\u0003\u0004word/document.xml', 'latin1')))[0]).toBe(400);
    // Review M13 F5: names in the bytes are not enough; the archive must be a real workbook.
    const fake = Buffer.from(`PK\u0003\u0004[Content_Types].xml xl/workbook.xml ${randomUUID()}`, 'latin1');
    expect(await refused('fake.xlsx', fake)).toEqual([400, 'This file is not a real XLSX file. Export it again from the program that made it.']);
    const notSheet = zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'xl/workbook.xml', data: '<workbook/>' }]);
    expect((await refused('doc.xlsx', notSheet))[0]).toBe(400);
    const macros = zip([
      { name: '[Content_Types].xml', data: SHEET_TYPES.replace('</Types>', '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>') },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'xl/vbaProject.bin', data: 'MZ' },
    ]);
    expect(await refused('macros.xlsx', macros)).toEqual([400, 'Workbooks with macros aren’t accepted. Save it as a plain .xlsx workbook and upload it again.']);
    // A crafted but well-formed sheet archive passes the content check (structure, not virus scanning; D15).
    expect((await uploadAs(consultant, clientId, zip([{ name: '[Content_Types].xml', data: SHEET_TYPES }, { name: 'xl/workbook.xml', data: `<workbook id="${randomUUID()}"/>` }]), { fileName: 'min.xlsx', docType: 'other' })).status).toBe(201);
    // A name without an extension is refused, whatever the name says.
    expect(await refused('pdf', PDF())).toEqual([400, 'Only PDF, PNG, JPEG, XLSX and CSV files are accepted.']);
    expect((await refused('data.csv', Buffer.from([0x61, 0x00, 0x62])))[0]).toBe(400);
    expect(await refused('empty.pdf', Buffer.alloc(0))).toEqual([400, 'This file is empty.']);
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(25 * 1024 * 1024)]);
    expect(await refused('big.pdf', big)).toEqual([413, 'Files over 25 MB aren’t accepted. Split or compress the file.']);
  });

  it('the same file twice for one client is named, and nothing is stored for refused uploads', async () => {
    const body = PDF('same');
    await upload(consultant, { title: 'Invoice 42' }, body);
    const before = t.files.files.size;
    const res = await uploadAs(consultant, clientId, body, { fileName: 'copy.pdf', docType: 'invoice' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This file is already in the evidence library as “Invoice 42”.');
    expect(res.body.error.details.existingId).toMatch(/^[0-9a-f-]{36}$/);
    await refused('setup.exe', Buffer.from('MZ'));
    expect(t.files.files.size).toBe(before);
  });
});

describe('M13-R4 evidence on an approved or issued period is frozen', () => {
  it('cannot be edited, deleted, unlinked, or newly linked once approved; issue keeps it so; the file stays', async () => {
    const p = await openPeriod(instB);
    const v = p.versions[0]!.id;
    const ev = await upload(consultant, { recordType: 'period_version', recordId: v });
    const spare = await upload(consultant);
    await approve(v);

    const detail = (await consultant.a.get(api(`/evidence/${ev.id}`))).body.evidence;
    expect(detail.locked).toBe(true);
    expect(detail.links[0].locked).toBe(true);
    expect((await consultant.a.delete(api(`/evidence/${ev.id}`))).status).toBe(409);
    expect((await consultant.a.patch(api(`/evidence/${ev.id}`), { title: 'Renamed' })).status).toBe(409);
    expect((await consultant.a.delete(api(`/evidence/${ev.id}/links/${detail.links[0].id}`))).status).toBe(409);
    const late = await consultant.a.post(api(`/evidence/${spare.id}/links`), { recordType: 'period_version', recordId: v });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/approved or issued/);

    // The database holds even without the API.
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) =>
        tx.updateTable('evidence_document').set({ deleted_at: new Date() }).where('id', '=', ev.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      withContext(t.db, ctxOf(consultant, 'consultant'), (tx) => tx.deleteFrom('evidence_link').where('evidence_id', '=', ev.id).execute()),
    ).rejects.toMatchObject({ code: '55000' });

    expect((await move(consultant.a, v, 'issue')).status).toBe(200);
    expect((await consultant.a.delete(api(`/evidence/${ev.id}`))).status).toBe(409);
    expect((await consultant.a.get(api(`/evidence/${ev.id}/download`))).status).toBe(200);
  });

  it('evidence on a draft period can be deleted (soft: the file stays for the audit period)', async () => {
    const p = await openPeriod(instB);
    const ev = await upload(consultant, { recordType: 'period_version', recordId: p.versions[0]!.id });
    const files = t.files.files.size;
    expect((await consultant.a.delete(api(`/evidence/${ev.id}`))).status).toBe(204);
    expect((await consultant.a.get(api(`/evidence/${ev.id}`))).status).toBe(404);
    expect(t.files.files.size).toBe(files);
  });

  it('a contributor edits and deletes only their own uploads', async () => {
    const theirs = await upload(contributor, { installationId: instA });
    const consultants = await upload(consultant, { installationId: instA });
    expect((await contributor.a.patch(api(`/evidence/${consultants.id}`), { title: 'x' })).status).toBe(403);
    expect((await contributor.a.delete(api(`/evidence/${consultants.id}`))).status).toBe(403);
    expect((await contributor.a.patch(api(`/evidence/${theirs.id}`), { title: 'Gas bill March' })).status).toBe(200);
    expect((await contributor.a.delete(api(`/evidence/${theirs.id}`))).status).toBe(204);
  });

  it('deleted evidence does not block or carry over into version 2 (review M13 F1)', async () => {
    const p = await openPeriod(instB);
    const v1 = p.versions[0]!.id;
    const kept = await upload(consultant, { recordType: 'period_version', recordId: v1 });
    const gone = await upload(consultant, { recordType: 'period_version', recordId: v1 });
    expect((await consultant.a.delete(api(`/evidence/${gone.id}`))).status).toBe(204);
    await approve(v1);
    await move(consultant.a, v1, 'issue');
    const next = await consultant.a.post(api(`/periods/${p.id}/versions`));
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const onV2 = (await consultant.a.get(api(`/records/period_version/${next.body.period.versions[0].id}/evidence`))).body.evidence;
    expect(onV2.map((e: { id: string }) => e.id)).toEqual([kept.id]);
    // And linking deleted evidence says so, instead of a 500.
    const late = await consultant.a.post(api(`/evidence/${gone.id}/links`), { recordType: 'installation', recordId: instB });
    expect(late.status).toBe(404); // deleted evidence is gone for the API
  });

  it('evidence on the period carries over to version 2 after issue', async () => {
    const p = await openPeriod(instB);
    const v1 = p.versions[0]!.id;
    const ev = await upload(consultant, { recordType: 'period_version', recordId: v1 });
    await approve(v1);
    await move(consultant.a, v1, 'issue');
    const next = await consultant.a.post(api(`/periods/${p.id}/versions`));
    expect(next.status).toBe(201);
    const v2 = next.body.period.versions[0].id;
    const onV2 = (await consultant.a.get(api(`/records/period_version/${v2}/evidence`))).body.evidence;
    expect(onV2.map((e: { id: string }) => e.id)).toEqual([ev.id]);
    // On v2 (a draft) it can be unlinked again, while v1's link stays frozen.
    const link = onV2[0].links.find((l: { recordId: string }) => l.recordId === v2);
    expect((await consultant.a.delete(api(`/evidence/${ev.id}/links/${link.id}`))).status).toBe(204);
  });
});

describe('M13-R5, R6 audit trail', () => {
  it('AT2: the app role cannot update, delete or truncate the audit log', async () => {
    const ctx = ctxOf({ id: admin.adminId }, 'platform_admin');
    await expect(withContext(t.db, ctx, (tx) => sql`update audit.audit_log set action = 'x'`.execute(tx))).rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.db, ctx, (tx) => sql`delete from audit.audit_log`.execute(tx))).rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.db, ctx, (tx) => sql`truncate audit.audit_log`.execute(tx))).rejects.toMatchObject({ code: '42501' });
  });

  it('R6: shows old and new values of each changed field, with user and action', async () => {
    const inst = await newInstallation();
    await consultant.a.patch(api(`/installations/${inst}`), { city: 'Jamnagar Rural' });
    const res = await consultant.a.get(api(`/audit?recordId=${inst}`));
    expect(res.status).toBe(200);
    const [edit, add] = res.body.entries;
    expect(edit).toMatchObject({
      action: 'Edit installation', op: 'UPDATE', table: 'public.installation', actorName: 'Cara Consultant', actorRole: 'consultant',
      changes: [{ field: 'city', old: 'c', new: 'Jamnagar Rural' }],
    });
    expect(add).toMatchObject({ action: 'Add installation', op: 'INSERT' });
    expect(add.changes.find((c: { field: string }) => c.field === 'city')).toEqual({ field: 'city', old: null, new: 'c' });
    expect(add.changes.map((c: { field: string }) => c.field)).not.toContain('created_by');
  });

  it('filters by user, module, record and time, newest first, with a cursor', async () => {
    const inst = await newInstallation();
    for (const city of ['A', 'B', 'C']) await consultant.a.patch(api(`/installations/${inst}`), { city });
    const page1 = (await consultant.a.get(api(`/audit?recordId=${inst}&limit=2`))).body;
    expect(page1.entries.map((e: { changes: { new: string }[] }) => e.changes[0]!.new)).toEqual(['C', 'B']);
    const page2 = (await consultant.a.get(api(`/audit?recordId=${inst}&limit=2&before=${page1.next}`))).body;
    expect(page2.entries.map((e: { op: string }) => e.op)).toEqual(['UPDATE', 'INSERT']);

    const byUser = (await admin.a.get(api(`/audit?userId=${reviewer.id}&clientId=${clientId}`))).body.entries;
    expect(byUser.every((e: { actorId: string }) => e.actorId === reviewer.id)).toBe(true);
    const m2 = (await consultant.a.get(api(`/audit?module=M2&clientId=${clientId}`))).body.entries;
    expect(m2.length).toBeGreaterThan(0);
    expect(m2.every((e: { table: string }) => ['public.client', 'public.installation', 'public.eu_importer'].includes(e.table))).toBe(true);
    const future = (await consultant.a.get(api(`/audit?clientId=${clientId}&from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`))).body.entries;
    expect(future).toEqual([]);
  });

  it('consultants and reviewers see their clients only; contributors and recipients have no trail; users stay admin-only', async () => {
    const mine = (await consultant.a.get(api('/audit?limit=200'))).body.entries;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e: { clientId: string }) => e.clientId === clientId)).toBe(true);
    const outsiders = (await outsider.a.get(api(`/audit?clientId=${clientId}`))).body.entries;
    expect(outsiders).toEqual([]);
    expect((await reviewer.a.get(api(`/audit?clientId=${clientId}`))).body.entries.length).toBeGreaterThan(0);
    expect((await contributor.a.get(api('/audit'))).status).toBe(403);
    expect((await recipient.a.get(api('/audit'))).status).toBe(403);
    // User records carry no client: admin-only. Assignments to the consultant's client are theirs to see.
    const userEntries = (await admin.a.get(api('/audit?table=public.app_user'))).body.entries;
    expect(userEntries.length).toBeGreaterThan(0);
    expect((await consultant.a.get(api('/audit?table=public.app_user'))).body.entries).toEqual([]);
    const m1 = (await consultant.a.get(api('/audit?module=M1'))).body.entries;
    expect(m1.every((e: { table: string; clientId: string }) => e.table.includes('assignment') && e.clientId === clientId)).toBe(true);
  });

  it('exports CSV: one line per changed field, formulas neutralised', async () => {
    const inst = await newInstallation();
    await consultant.a.patch(api(`/installations/${inst}`), { city: '=HYPERLINK("x")' });
    const res = await consultant.a.raw.get(api(`/audit.csv?recordId=${inst}`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('"Time (UTC)","User","Role","Action","Operation","Table","Record","Field","Old value","New value","Reason"');
    expect(lines[1]).toContain('"city","c","\'=HYPERLINK(""x"")"');
  });

  it('evidence changes are in the trail with their verbs', async () => {
    const ev = await upload(consultant, { title: 'Invoice 7' });
    await consultant.a.patch(api(`/evidence/${ev.id}`), { title: 'Invoice 7 (gas)' });
    const actions = (await consultant.a.get(api(`/audit?recordId=${ev.id}`))).body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['Edit evidence', 'Upload evidence']);
  });
});

describe('M13-R7 verification per period', () => {
  const verifier = {
    verifierName: 'TÜV Verifica GmbH', verifierStreet: 'Hauptstraße 1', verifierCity: 'München', verifierPostcode: '80331', verifierCountryCode: 'DE',
    repName: 'Lena Lead', repEmail: 'lena@verifica.example', repPhone: '+49 89 1234', accreditationMemberState: 'DE',
    accreditationBody: 'DAkkS', accreditationRegNo: 'D-VS-12345-01', siteVisitDate: '2027-02-10',
    opinion: 'Reasonable assurance: the report is free of material misstatement.', findings: ['Meter M3 calibration certificate expired in March.'],
  };

  it('the reviewer records details; the consultant and a client user approve; any change withdraws approvals', async () => {
    const p = await openPeriod(instA);
    const v = p.versions[0]!.id;
    const empty = (await consultant.a.get(api(`/period-versions/${v}/verification`))).body.verification;
    expect(empty).toMatchObject({ id: null, verifierName: null, findings: [], consultantApproval: null });

    const saved = await reviewer.a.put(api(`/period-versions/${v}/verification`), verifier);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.verification).toMatchObject(verifier);

    expect((await contributor.a.put(api(`/period-versions/${v}/verification`), { opinion: 'x' })).status).toBe(403);
    expect((await reviewer.a.post(api(`/period-versions/${v}/verification/approvals`), { kind: 'consultant', approved: true })).status).toBe(403);
    expect((await consultant.a.post(api(`/period-versions/${v}/verification/approvals`), { kind: 'client', approved: true })).status).toBe(403);

    const c = await consultant.a.post(api(`/period-versions/${v}/verification/approvals`), { kind: 'consultant', approved: true });
    expect(c.body.verification.consultantApproval).toMatchObject({ by: 'Cara Consultant' });
    const k = await recipient.a.post(api(`/period-versions/${v}/verification/approvals`), { kind: 'client', approved: true });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(k.body.verification.clientApproval).toMatchObject({ by: 'Rita Recipient' });

    const changed = await reviewer.a.put(api(`/period-versions/${v}/verification`), { findings: [...verifier.findings, 'Second finding.'] });
    expect(changed.body.verification).toMatchObject({ consultantApproval: null, clientApproval: null });
  });

  it('the database enforces who approves and stamps the approver itself', async () => {
    const p = await openPeriod(instA);
    const v = p.versions[0]!.id;
    await reviewer.a.put(api(`/period-versions/${v}/verification`), { verifierName: 'X' });
    await expect(
      withContext(t.db, ctxOf(reviewer, 'reviewer'), (tx) =>
        tx.updateTable('verification').set({ client_approved_at: new Date(), client_approved_by: reviewer.id }).where('period_version_id', '=', v).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await withContext(t.db, ctxOf(contributor, 'contributor'), (tx) =>
      tx.updateTable('verification').set({ client_approved_at: new Date('2000-01-01'), client_approved_by: consultant.id }).where('period_version_id', '=', v).execute(),
    );
    const { rows } = await sql<{ by: string; recent: boolean }>`
      select client_approved_by as by, client_approved_at > now() - interval '1 minute' as recent
        from verification where period_version_id = ${v}`.execute(t.su);
    expect(rows[0]).toEqual({ by: contributor.id, recent: true });
  });

  it('is locked with the period and invisible to other clients', async () => {
    const p = await openPeriod(instA);
    const v = p.versions[0]!.id;
    await reviewer.a.put(api(`/period-versions/${v}/verification`), { verifierName: 'X' });
    await approve(v);
    const late = await reviewer.a.put(api(`/period-versions/${v}/verification`), { opinion: 'Changed' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('locked');
    expect((await outsider.a.get(api(`/period-versions/${v}/verification`))).status).toBe(404);
  });

  it('validation: country codes, email and dates', async () => {
    const p = await openPeriod(instA);
    const res = await reviewer.a.put(api(`/period-versions/${p.versions[0]!.id}/verification`), { repEmail: 'not-an-email', siteVisitDate: '2027-02-30' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues.map((i: { path: string[] }) => i.path[0]).sort()).toEqual(['repEmail', 'siteVisitDate']);
    expect((await reviewer.a.put(api(`/period-versions/${p.versions[0]!.id}/verification`), { accreditationMemberState: 'ZZ' })).status).toBe(400);
  });
});

it('uploads need the same origin (CSRF)', async () => {
  const res = await request(t.app).post(api(`/clients/${clientId}/evidence`)).query({ fileName: 'a.pdf', docType: 'other' }).send(PDF());
  expect([401, 403]).toContain(res.status);
});

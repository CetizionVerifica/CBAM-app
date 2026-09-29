import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type Db, type RequestContext, createDb, withContext } from '../src/platform/db';

// Exercises the platform foundation migration with a throwaway business table,
// registered exactly as module tables will be.

let owner: Db;
let app: Db;

const tenantA = randomUUID();
const tenantB = randomUUID();
const ctx = (tenantId: string, extra: Partial<RequestContext> = {}): RequestContext => ({
  tenantId,
  userId: randomUUID(),
  userRole: 'consultant',
  requestId: randomUUID(),
  ...extra,
});

beforeAll(async () => {
  owner = createDb(inject('ownerUrl'));
  app = createDb(inject('appUrl'));
  await sql`
    create table public.test_widget (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      client_id uuid not null,
      name text not null,
      secret text,
      created_at timestamptz not null, created_by uuid not null,
      updated_at timestamptz not null, updated_by uuid not null
    )`.execute(owner);
  await sql`select app.register_business_table('public.test_widget', '{secret}')`.execute(owner);
  await sql`create policy tenant_isolation on public.test_widget to cbam_app
              using (tenant_id = app.current_tenant_id())
              with check (tenant_id = app.current_tenant_id())`.execute(owner);
  await sql`grant select, insert, update, delete on public.test_widget to cbam_app`.execute(owner);
});

afterAll(async () => {
  await app.destroy();
  await owner.destroy();
});

const insertWidget = (c: RequestContext, name: string, secret = 's1') =>
  withContext(app, c, async (tx) => {
    const { rows } = await sql<{ id: string }>`
      insert into public.test_widget (tenant_id, client_id, name, secret)
      values (${c.tenantId}, ${randomUUID()}, ${name}, ${secret}) returning id`.execute(tx);
    return rows[0]!.id;
  });

const auditFor = (c: RequestContext, id: string) =>
  withContext(app, c, (tx) =>
    tx.selectFrom('audit.audit_log').selectAll().where('record_id', '=', id).orderBy('id').execute(),
  );

describe('audit trigger (G3)', () => {
  it('logs inserts with actor, verb, request id and new values', async () => {
    const c = ctx(tenantA, { action: 'Add widget' });
    const id = await insertWidget(c, 'first');
    const [entry] = await auditFor(c, id);
    expect(entry).toMatchObject({
      op: 'INSERT',
      table_name: 'public.test_widget',
      actor_user_id: c.userId,
      actor_role: 'consultant',
      action: 'Add widget',
      request_id: c.requestId,
      tenant_id: tenantA,
      old_row: null,
    });
    expect(entry!.new_row).toMatchObject({ name: 'first', created_by: c.userId });
  });

  it('logs updates with old and new values and the changed fields only', async () => {
    const c = ctx(tenantA);
    const id = await insertWidget(c, 'before');
    await withContext(app, { ...c, action: 'Rename widget', reason: 'typo' }, (tx) =>
      sql`update public.test_widget set name = 'after' where id = ${id}`.execute(tx),
    );
    const entries = await auditFor(c, id);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ op: 'UPDATE', changed_fields: ['name'], reason: 'typo' });
    expect(entries[1]!.old_row).toMatchObject({ name: 'before' });
    expect(entries[1]!.new_row).toMatchObject({ name: 'after' });
  });

  it('redacts secret columns but still records that they changed', async () => {
    const c = ctx(tenantA);
    const id = await insertWidget(c, 'w', 'hunter2');
    await withContext(app, c, (tx) => sql`update public.test_widget set secret = 'new' where id = ${id}`.execute(tx));
    const entries = await auditFor(c, id);
    expect(JSON.stringify(entries)).not.toContain('hunter2');
    expect(entries[1]).toMatchObject({ changed_fields: ['secret'], new_row: expect.objectContaining({ secret: '[redacted]' }) });
  });

  it('logs deletes with the old row', async () => {
    const c = ctx(tenantA);
    const id = await insertWidget(c, 'gone');
    await withContext(app, c, (tx) => sql`delete from public.test_widget where id = ${id}`.execute(tx));
    const entries = await auditFor(c, id);
    expect(entries.at(-1)).toMatchObject({ op: 'DELETE', new_row: null, old_row: expect.objectContaining({ name: 'gone' }) });
  });

  it('rejects business writes without a request context', async () => {
    await expect(
      sql`insert into public.test_widget (tenant_id, client_id, name) values (${tenantA}, ${randomUUID()}, 'x')`.execute(owner),
    ).rejects.toThrow(/app.user_id is not set/);
  });

  it('keeps created_by fixed on update', async () => {
    const c1 = ctx(tenantA);
    const id = await insertWidget(c1, 'w');
    const c2 = ctx(tenantA);
    const row = await withContext(app, c2, async (tx) => {
      await sql`update public.test_widget set created_by = ${c2.userId}, name = 'w2' where id = ${id}`.execute(tx);
      const { rows } = await sql<{ created_by: string; updated_by: string }>`
        select created_by, updated_by from public.test_widget where id = ${id}`.execute(tx);
      return rows[0]!;
    });
    expect(row).toEqual({ created_by: c1.userId, updated_by: c2.userId });
  });
});

describe('audit log is append-only (M13-R5, M13 AT2)', () => {
  it('denies UPDATE and DELETE to the app role', async () => {
    const c = ctx(tenantA);
    await insertWidget(c, 'w');
    await expect(
      withContext(app, c, (tx) => sql`update audit.audit_log set action = 'forged'`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withContext(app, c, (tx) => sql`delete from audit.audit_log`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withContext(app, c, (tx) =>
        sql`insert into audit.audit_log (actor_user_id, op, table_name) values (${c.userId}, 'INSERT', 'x')`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('blocks UPDATE, DELETE and TRUNCATE even for the owner', async () => {
    await expect(sql`update audit.audit_log set action = 'forged'`.execute(owner)).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit.audit_log`.execute(owner)).rejects.toThrow(/append-only/);
    await expect(sql`truncate audit.audit_log`.execute(owner)).rejects.toThrow(/append-only/);
  });
});

describe('row-level security (G1)', () => {
  it('hides other tenants\' rows and their audit entries', async () => {
    const a = ctx(tenantA);
    const b = ctx(tenantB);
    const id = await insertWidget(a, 'tenant A only');

    const seenByB = await withContext(app, b, async (tx) => {
      const { rows } = await sql`select id from public.test_widget where id = ${id}`.execute(tx);
      return rows;
    });
    expect(seenByB).toHaveLength(0);
    expect(await auditFor(b, id)).toHaveLength(0);
  });

  it('cannot write a row into another tenant', async () => {
    const a = ctx(tenantA);
    await expect(
      withContext(app, a, (tx) =>
        sql`insert into public.test_widget (tenant_id, client_id, name) values (${tenantB}, ${randomUUID()}, 'x')`.execute(tx),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('sees nothing without a request context', async () => {
    const { rows } = await sql`select count(*)::int as n from public.test_widget`.execute(app);
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe('date handling (M3-R8)', () => {
  it('returns date columns as plain YYYY-MM-DD strings', async () => {
    const { rows } = await sql<{ d: string }>`select date '2026-12-31' as d`.execute(app);
    expect(rows[0]!.d).toBe('2026-12-31');
  });
});

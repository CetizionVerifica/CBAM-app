import type { PeriodCopier } from '../m03-periods';
import type { Tx } from '../../platform/db';
import { loadGoods } from '../m04-reference/data';
import { precursorsOf } from './load';

/** Columns every M5 row takes from its period version. */
async function scopeOf(tx: Tx, periodVersionId: string) {
  const v = await tx
    .selectFrom('period_version as v')
    .innerJoin('library_version as l', 'l.id', 'v.library_version_id')
    .select(['v.tenant_id', 'v.client_id', 'v.installation_id', 'v.id as period_version_id', 'v.library_version_id', 'l.code as library_code'])
    .where('v.id', '=', periodVersionId)
    .executeTakeFirstOrThrow();
  const { library_code, ...scope } = v;
  return { scope, libraryCode: library_code };
}

const loadAll = (tx: Tx, periodVersionId: string) =>
  Promise.all([
    tx.selectFrom('production_process').selectAll().where('period_version_id', '=', periodVersionId).orderBy('position').execute(),
    tx.selectFrom('process_included_category').selectAll().where('period_version_id', '=', periodVersionId).execute(),
    tx.selectFrom('process_route').selectAll().where('period_version_id', '=', periodVersionId).execute(),
    tx.selectFrom('process_good').selectAll().where('period_version_id', '=', periodVersionId).execute(),
    tx.selectFrom('process_good_parameter').selectAll().where('period_version_id', '=', periodVersionId).execute(),
    tx.selectFrom('process_internal_use').selectAll().where('period_version_id', '=', periodVersionId).execute(),
  ]);

const META = ['id', 'created_at', 'created_by', 'updated_at', 'updated_by'] as const;
const SCOPE = ['tenant_id', 'client_id', 'installation_id', 'period_version_id', 'library_version_id'] as const;
function strip<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of [...META, ...SCOPE]) delete out[k];
  return out;
}

/**
 * M3-R6 (clone): processes, included categories, routes and goods, with no quantities or
 * parameter values. The new period pins the current library, so rows whose codes it no longer
 * has are skipped and reported (D23).
 */
export const copyProcessSetup: PeriodCopier = async (tx, from, to) => {
  const [processes, included, routes, goods, , uses] = await loadAll(tx, from.periodVersionId);
  if (processes.length === 0) return [];
  const { scope, libraryCode } = await scopeOf(tx, to.periodVersionId);
  const entries = await loadGoods(tx, scope.library_version_id);
  const library = new Map(entries.map((c) => [c.code, c]));
  const cnCodes = new Map(
    (await tx.selectFrom('cn_code').select(['code', 'goods_category_code']).where('library_version_id', '=', scope.library_version_id).execute()).map((c) => [
      c.code,
      c.goods_category_code,
    ]),
  );
  const notes: string[] = [];
  const ids = new Map<string, string>();

  for (const p of processes) {
    const cat = library.get(p.goods_category_code);
    if (!cat) {
      notes.push(`Process ${p.name} was not copied: its goods category is not in library version ${libraryCode}.`);
      continue;
    }
    const row = await tx
      .insertInto('production_process')
      .values({ ...scope, position: p.position, name: p.name, goods_category_code: p.goods_category_code } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.set(p.id, row.id);

    const myRoutes = routes.filter((r) => r.process_id === p.id);
    const keep = myRoutes.filter((r) => (r.route_code === null ? !cat.routeRelevant : cat.routes.some((x) => x.code === r.route_code)));
    if (keep.length < myRoutes.length) notes.push(`${p.name}: routes that are not in library version ${libraryCode} were not copied.`);
    if (keep.length) {
      await tx
        .insertInto('process_route')
        .values(keep.map((r) => ({ ...scope, goods_category_code: p.goods_category_code, process_id: row.id, route_code: r.route_code })) as never)
        .execute();
    }

    const precursors = precursorsOf(entries, p.goods_category_code);
    for (const inc of included.filter((i) => i.process_id === p.id)) {
      const c = library.get(inc.goods_category_code);
      if (!c || !precursors.has(c.code)) {
        notes.push(`${p.name}: ${c?.name ?? inc.goods_category_code} is not a relevant precursor in library version ${libraryCode} and was not included.`);
        continue;
      }
      await tx
        .insertInto('process_included_category')
        .values({
          ...scope,
          process_id: row.id,
          goods_category_code: inc.goods_category_code,
          route_codes: inc.route_codes.filter((r) => c.routes.some((x) => x.code === r)),
        } as never)
        .execute();
    }

    const myGoods = goods.filter((g) => g.process_id === p.id);
    const okGoods = myGoods.filter((g) => cnCodes.get(g.cn_code) === p.goods_category_code);
    for (const g of myGoods.filter((x) => !okGoods.includes(x))) {
      notes.push(`${p.name}: CN code ${g.cn_code} is not a ${cat.name} code in library version ${libraryCode} and was not copied.`);
    }
    if (okGoods.length) {
      await tx
        .insertInto('process_good')
        .values(okGoods.map((g) => ({ ...scope, goods_category_code: p.goods_category_code, process_id: row.id, cn_code: g.cn_code, product_name: g.product_name })) as never)
        .execute();
    }
  }

  // Which process feeds which is set-up too; the amounts are data.
  const pairs = uses.filter((u) => ids.has(u.process_id) && ids.has(u.consumer_process_id));
  if (pairs.length) {
    await tx
      .insertInto('process_internal_use')
      .values(pairs.map((u) => ({ ...scope, process_id: ids.get(u.process_id), consumer_process_id: ids.get(u.consumer_process_id) })) as never)
      .execute();
  }
  return notes;
};

/**
 * M3-R5 (new version): everything, data included, with the evidence links of processes and
 * goods (M13 copies the period's own links). Version n+1 keeps version n's library pin (D14),
 * so every code stays valid. Processes start as drafts again: completeness is confirmed per
 * version (D20).
 */
export const copyProcessData: PeriodCopier = async (tx, from, to) => {
  const [processes, included, routes, goods, params, uses] = await loadAll(tx, from.periodVersionId);
  if (processes.length === 0) return;
  const { scope } = await scopeOf(tx, to.periodVersionId);
  const pIds = new Map<string, string>();
  const gIds = new Map<string, string>();

  for (const p of processes) {
    const { status: _s, completed_at: _a, completed_by: _b, ...rest } = strip(p);
    const row = await tx.insertInto('production_process').values({ ...scope, ...rest } as never).returning('id').executeTakeFirstOrThrow();
    pIds.set(p.id, row.id);
  }
  const copy = async (table: 'process_included_category' | 'process_route', rows: { process_id: string }[]) => {
    if (rows.length) {
      await tx
        .insertInto(table)
        .values(rows.map((r) => ({ ...scope, ...strip(r), process_id: pIds.get(r.process_id) })) as never)
        .execute();
    }
  };
  await copy('process_included_category', included);
  await copy('process_route', routes);
  for (const g of goods) {
    const row = await tx
      .insertInto('process_good')
      .values({ ...scope, ...strip(g), process_id: pIds.get(g.process_id) } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    gIds.set(g.id, row.id);
  }
  if (params.length) {
    await tx
      .insertInto('process_good_parameter')
      .values(params.map((v) => ({ ...scope, ...strip(v), good_id: gIds.get(v.good_id) })) as never)
      .execute();
  }
  if (uses.length) {
    await tx
      .insertInto('process_internal_use')
      .values(uses.map((u) => ({ ...scope, ...strip(u), process_id: pIds.get(u.process_id), consumer_process_id: pIds.get(u.consumer_process_id) })) as never)
      .execute();
  }

  // Evidence of processes and goods goes with them; links to deleted evidence stay behind (M13 F1).
  const links = await tx
    .selectFrom('evidence_link as l')
    .innerJoin('evidence_document as d', 'd.id', 'l.evidence_id')
    .select(['l.tenant_id', 'l.client_id', 'l.evidence_id', 'l.record_table', 'l.record_id'])
    .where('l.period_version_id', '=', from.periodVersionId)
    .where('l.record_table', 'in', ['production_process', 'process_good'])
    .where('d.deleted_at', 'is', null)
    .execute();
  if (links.length) {
    await tx
      .insertInto('evidence_link')
      .values(
        links.map((l) => ({
          tenant_id: l.tenant_id,
          client_id: l.client_id,
          evidence_id: l.evidence_id,
          record_table: l.record_table,
          record_id: (l.record_table === 'production_process' ? pIds : gIds).get(l.record_id),
        })) as never,
      )
      .execute();
  }
};


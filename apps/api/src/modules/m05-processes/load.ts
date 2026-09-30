import {
  type AmountInput,
  Decimal,
  type GoodsCategoryEntry,
  type PeriodStatus,
  type ProcessCheck,
  type ProcessDetail,
  type ProcessFacts,
  type ProcessStatus,
  type Provenance,
  type QuantityInput,
  type StoredAmount,
  baseUnit,
  categoryDimension,
  isPeriodLocked,
  normaliseQuantity,
  processChecks,
  productionBalance,
} from '@cbam/shared';
import type { Tx } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { loadGoods, loadSettings } from '../m04-reference/data';

export const notFound = (what: string) => new AppError(404, 'not_found', `This ${what} does not exist or you do not have access to it.`);

// ---------------------------------------------------------------------------
// Quantity column groups (G5, G7): <prefix>_value, _unit, _si, _source, _provenance, _default_ref
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

export function storedAmount(row: Row, prefix: string): StoredAmount | null {
  const value = row[`${prefix}_value`] as string | null;
  if (value === null || value === undefined) return null;
  return {
    value: new Decimal(value).toString(),
    unit: row[`${prefix}_unit`] as string,
    si: new Decimal(row[`${prefix}_si`] as string).toString(),
    source: row[`${prefix}_source`] as string,
    provenance: row[`${prefix}_provenance`] as Provenance,
    defaultRef: (row[`${prefix}_default_ref`] as string | null) ?? null,
  };
}

/** Columns for one quantity group; `null` clears the group. */
export function amountColumns(prefix: string, q: QuantityInput | null): Record<string, string | null> {
  const n = q ? normaliseQuantity(q) : null;
  return {
    [`${prefix}_value`]: n?.value ?? null,
    [`${prefix}_unit`]: n?.unit ?? null,
    [`${prefix}_si`]: n?.si ?? null,
    [`${prefix}_source`]: n?.source ?? null,
    [`${prefix}_provenance`]: n?.provenance ?? null,
    [`${prefix}_default_ref`]: n?.defaultRef ?? null,
  };
}

/** Production amounts are in the unit of the main category: t (mass) or MWh (electricity). */
export function checkAmountUnit(q: AmountInput | null, categoryUnit: string, path: (string | number)[]) {
  if (!q) return [];
  const dim = categoryDimension(categoryUnit);
  const ok = normaliseQuantity(q).siUnit === baseUnit(dim);
  return ok ? [] : [{ path, message: `Enter this amount in ${dim === 'electricity' ? 'kWh, MWh or GWh' : 'kg, t or kt'}.` }];
}

/** Relevant precursors of a category, directly or through other precursors (D16, G9). */
export function precursorsOf(library: GoodsCategoryEntry[], main: string): Set<string> {
  const byCode = new Map(library.map((c) => [c.code, c]));
  const seen = new Set<string>();
  const stack = [main];
  while (stack.length) {
    for (const p of byCode.get(stack.pop()!)?.precursors ?? []) {
      if (!seen.has(p.precursorCode)) {
        seen.add(p.precursorCode);
        stack.push(p.precursorCode);
      }
    }
  }
  seen.delete(main);
  return seen;
}

// ---------------------------------------------------------------------------
// The period version and everything M5 holds for it
// ---------------------------------------------------------------------------

export async function loadVersion(tx: Tx, periodVersionId: string) {
  const v = await tx
    .selectFrom('period_version as v')
    .innerJoin('library_version as l', 'l.id', 'v.library_version_id')
    .select(['v.id', 'v.tenant_id', 'v.client_id', 'v.installation_id', 'v.status', 'v.library_version_id', 'l.code as library_code'])
    .where('v.id', '=', periodVersionId)
    .executeTakeFirst();
  if (!v) throw notFound('reporting period');
  return { ...v, locked: isPeriodLocked(v.status as PeriodStatus) };
}

export async function loadProcessRow(tx: Tx, id: string, lock = false) {
  let q = tx.selectFrom('production_process').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('process');
  return row;
}

export type ProcessRow = Awaited<ReturnType<typeof loadProcessRow>>;

/** All processes of a version with their checks (D20). One query per table, whatever the count. */
export async function loadVersionProcesses(tx: Tx, periodVersionId: string, only?: string): Promise<{ details: ProcessDetail[]; library: GoodsCategoryEntry[] }> {
  const version = await loadVersion(tx, periodVersionId);
  const lib = version.library_version_id;
  const [processes, routes, included, goods, params, uses, library, settings] = await Promise.all([
    tx.selectFrom('production_process').selectAll().where('period_version_id', '=', periodVersionId).orderBy('position').execute(),
    tx.selectFrom('process_route').selectAll().where('period_version_id', '=', periodVersionId).execute(),
    tx.selectFrom('process_included_category').selectAll().where('period_version_id', '=', periodVersionId).orderBy('created_at').execute(),
    tx.selectFrom('process_good').selectAll().where('period_version_id', '=', periodVersionId).orderBy('cn_code').orderBy('product_name').execute(),
    tx.selectFrom('process_good_parameter').selectAll().where('period_version_id', '=', periodVersionId).orderBy('position').execute(),
    tx.selectFrom('process_internal_use').selectAll().where('period_version_id', '=', periodVersionId).execute(),
    loadGoods(tx, lib),
    loadSettings(tx, lib),
  ]);
  const cnCodes = [...new Set(goods.map((g) => g.cn_code))];
  const cnDescriptions = new Map(
    cnCodes.length
      ? (await tx.selectFrom('cn_code').select(['code', 'description']).where('library_version_id', '=', lib).where('code', 'in', cnCodes).execute()).map(
          (c) => [c.code, c.description],
        )
      : [],
  );
  const users = new Map(
    (
      await Promise.all(
        [...new Set(processes.map((p) => p.completed_by).filter((u): u is string => u !== null))].map((id) =>
          tx.selectFrom('app_user').select(['id', 'display_name']).where('id', '=', id).executeTakeFirst(),
        ),
      )
    )
      .filter((u) => u !== undefined)
      .map((u) => [u.id, u.display_name]),
  );
  const cat = new Map(library.map((c) => [c.code, c]));
  const names = new Map(processes.map((p) => [p.id, p.name]));

  const details = processes
    .filter((p) => only === undefined || p.id === only)
    .map((p): ProcessDetail => {
      const c = cat.get(p.goods_category_code)!;
      const routeName = new Map(c.routes.map((r) => [r.code, r.name]));
      const routeOrder = new Map(c.routes.map((r, i) => [r.code, i]));
      const myRoutes = routes
        .filter((r) => r.process_id === p.id)
        .sort((a, b) => (routeOrder.get(a.route_code ?? '') ?? 0) - (routeOrder.get(b.route_code ?? '') ?? 0))
        .map((r) => ({ id: r.id, routeCode: r.route_code, routeName: r.route_code ? (routeName.get(r.route_code) ?? r.route_code) : null, amount: storedAmount(r, 'amount') }));
      const myGoods = goods
        .filter((g) => g.process_id === p.id)
        .map((g) => ({
          id: g.id,
          cnCode: g.cn_code,
          cnDescription: cnDescriptions.get(g.cn_code) ?? '',
          productName: g.product_name,
          produced: storedAmount(g, 'produced'),
          soldEu: storedAmount(g, 'sold_eu'),
          soldOther: storedAmount(g, 'sold_other'),
          parameters: params
            .filter((v) => v.good_id === g.id)
            .map((v) => ({ position: v.position, text: v.value_text, quantity: storedAmount(v, 'value') })),
        }));
      const myUses = uses
        .filter((u) => u.process_id === p.id)
        .map((u) => ({ id: u.id, consumerProcessId: u.consumer_process_id, consumerName: names.get(u.consumer_process_id) ?? '', amount: storedAmount(u, 'amount') }));
      const nonCbam = storedAmount(p, 'non_cbam');
      const unit = c.unit;
      const facts: ProcessFacts = {
        id: p.id,
        name: p.name,
        unit,
        routes: myRoutes.map((r) => ({ id: r.id, label: r.routeName, amountSi: r.amount?.si ?? null })),
        goods: myGoods.map((g) => ({
          id: g.id,
          label: `${g.cnCode}${g.productName ? ` ${g.productName}` : ''}`,
          producedSi: g.produced?.si ?? null,
          soldEuSi: g.soldEu?.si ?? null,
          soldOtherSi: g.soldOther?.si ?? null,
          filledPositions: g.parameters.map((v) => v.position),
        })),
        qualifyingParameters: c.qualifyingParameters,
        internalUses: myUses.map((u) => ({ id: u.id, consumerName: u.consumerName, amountSi: u.amount?.si ?? null })),
        nonCbamSi: nonCbam?.si ?? null,
        tolerance: settings.productionBalanceTolerance,
      };
      const checks: ProcessCheck[] = processChecks(facts);
      const balance = productionBalance(facts);
      return {
        id: p.id,
        position: p.position,
        name: p.name,
        goodsCategory: { code: c.code, name: c.name, unit },
        status: p.status as ProcessStatus,
        activityLevel: balance.activityLevel,
        goodsCount: myGoods.length,
        openChecks: {
          critical: checks.filter((x) => x.severity === 'critical').length,
          warning: checks.filter((x) => x.severity === 'warning').length,
        },
        periodVersionId,
        installationId: p.installation_id,
        clientId: p.client_id,
        libraryVersionId: lib,
        routeRelevant: c.routeRelevant,
        routes: myRoutes,
        includedCategories: included
          .filter((i) => i.process_id === p.id)
          .map((i) => ({ code: i.goods_category_code, name: cat.get(i.goods_category_code)?.name ?? i.goods_category_code, routeCodes: i.route_codes })),
        goods: myGoods,
        qualifyingParameters: c.qualifyingParameters,
        internalUses: myUses,
        nonCbam,
        balance,
        checks,
        completedAt: p.completed_at?.toISOString() ?? null,
        completedBy: p.completed_by ? (users.get(p.completed_by) ?? null) : null,
        otherProcesses: processes.filter((o) => o.id !== p.id).map((o) => ({ id: o.id, name: o.name })),
      };
    });
  return { details, library };
}

export async function loadProcessDetail(tx: Tx, id: string): Promise<ProcessDetail> {
  const row = await loadProcessRow(tx, id);
  const { details } = await loadVersionProcesses(tx, row.period_version_id, id);
  return details[0]!;
}

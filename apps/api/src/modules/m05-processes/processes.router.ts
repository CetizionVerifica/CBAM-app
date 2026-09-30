import { Router } from 'express';
import { z } from 'zod';
import {
  type AffectedRecord,
  ConfirmQuery,
  CreateProcessRequest,
  GoodDataRequest,
  GoodInput,
  GoodPatch,
  type GoodsCategoryEntry,
  MAX_CATEGORIES,
  MAX_PROCESSES,
  type ProcessDetail,
  type ProcessList,
  ProductionRequest,
  UpdateProcessRequest,
  canComplete,
  normaliseQuantity,
} from '@cbam/shared';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { mapDbError } from '../../platform/db-errors';
import { type Db, type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { assertPeriodWritable } from '../m03-periods';
import {
  type ProcessDependents,
  evidenceAffected,
  goodAffected,
  removeEvidenceLinks,
  requireConfirmation,
  routeAffected,
} from './dependents';
import {
  amountColumns,
  checkAmountUnit,
  loadProcessDetail,
  loadProcessRow,
  loadVersion,
  loadVersionProcesses,
  notFound,
  precursorsOf,
} from './load';

const Id = z.uuid();
const idParam = (raw: unknown, what: string): string => {
  const r = Id.safeParse(raw);
  if (!r.success) throw notFound(what);
  return r.data;
};

type Issue = { path: (string | number)[]; message: string };
const invalid = (issues: Issue[]) => new AppError(400, 'validation_failed', 'Some fields are not valid. Fix them and try again.', undefined, issues);

const UNIQUE = {
  production_process_name: 'Another process of this period already has this name.',
  process_good_unique: 'This process already has this CN code with this product name.',
};

interface SetupInput {
  goodsCategoryCode: string;
  routeCodes: string[];
  includedCategories: { code: string; routeCodes: string[] }[];
}

/** M5-R1 and D16: codes from the pinned library, routes of their category, precursors only. */
function checkSetup(library: GoodsCategoryEntry[], v: SetupInput): Issue[] {
  const byCode = new Map(library.map((c) => [c.code, c]));
  const main = byCode.get(v.goodsCategoryCode);
  if (!main) return [{ path: ['goodsCategoryCode'], message: 'Choose a goods category from the list.' }];
  const issues: Issue[] = [];
  if (main.routeRelevant && v.routeCodes.length === 0) {
    issues.push({ path: ['routeCodes'], message: 'Choose at least one production route.' });
  }
  if (!main.routeRelevant && v.routeCodes.length > 0) {
    issues.push({ path: ['routeCodes'], message: `${main.name} has no production routes.` });
  }
  v.routeCodes.forEach((r, i) => {
    if (main.routeRelevant && !main.routes.some((x) => x.code === r)) {
      issues.push({ path: ['routeCodes', i], message: `Choose a route of ${main.name}.` });
    }
  });
  const precursors = precursorsOf(library, main.code);
  v.includedCategories.forEach((inc, i) => {
    const c = byCode.get(inc.code);
    if (!c || !precursors.has(inc.code)) {
      issues.push({ path: ['includedCategories', i, 'code'], message: `Choose a relevant precursor of ${main.name}.` });
      return;
    }
    inc.routeCodes.forEach((r, j) => {
      if (!c.routes.some((x) => x.code === r)) {
        issues.push({ path: ['includedCategories', i, 'routeCodes', j], message: `Choose a route of ${c.name}.` });
      }
    });
  });
  return issues;
}

/** Any change to a process or its data returns it to draft (D20). */
const backToDraft = (tx: Tx, processId: string) =>
  tx.updateTable('production_process').set({ status: 'draft' }).where('id', '=', processId).where('status', '=', 'complete').execute();

/**
 * M5 — process and goods set-up. Every query runs under the caller's context, so RLS decides
 * what exists (G1); the period lock is checked here and again by the database (G4). Set-up
 * routes need `processes.configure`, data routes `processes.enterData` (D21).
 */
export function processesRouter({ db, dependents = [] }: { db: Db; dependents?: ProcessDependents[] }): Router {
  const router = Router();
  router.use(['/period-versions/:id/processes', '/processes', '/process-goods'], requireAuth);
  const read = requirePermission('processes.read');
  const configure = requirePermission('processes.configure');
  const enter = requirePermission('processes.enterData');

  /** Distinct categories across the version after a change (G1–G10 in the template). */
  const checkCategoryCount = async (tx: Tx, periodVersionId: string, processId: string | null, next: SetupInput) => {
    const { details } = await loadVersionProcesses(tx, periodVersionId);
    const codes = new Set<string>([next.goodsCategoryCode, ...next.includedCategories.map((c) => c.code)]);
    for (const p of details.filter((d) => d.id !== processId)) {
      codes.add(p.goodsCategory.code);
      for (const c of p.includedCategories) codes.add(c.code);
    }
    if (codes.size > MAX_CATEGORIES) {
      throw new AppError(409, 'too_many_categories', `A period can cover at most ${MAX_CATEGORIES} goods categories, the rows the template has (G1–G10).`);
    }
  };

  const writeIncluded = async (tx: Tx, p: { id: string; tenant_id: string; client_id: string; installation_id: string; period_version_id: string; library_version_id: string }, next: SetupInput['includedCategories']) => {
    const existing = await tx.selectFrom('process_included_category').selectAll().where('process_id', '=', p.id).execute();
    const drop = existing.filter((e) => !next.some((n) => n.code === e.goods_category_code));
    if (drop.length) await tx.deleteFrom('process_included_category').where('id', 'in', drop.map((d) => d.id)).execute();
    for (const n of next) {
      const e = existing.find((x) => x.goods_category_code === n.code);
      if (!e) {
        await tx
          .insertInto('process_included_category')
          .values({
            tenant_id: p.tenant_id,
            client_id: p.client_id,
            installation_id: p.installation_id,
            period_version_id: p.period_version_id,
            library_version_id: p.library_version_id,
            process_id: p.id,
            goods_category_code: n.code,
            route_codes: n.routeCodes,
          } as never)
          .execute();
      } else if (e.route_codes.join('|') !== n.routeCodes.join('|')) {
        await tx.updateTable('process_included_category').set({ route_codes: n.routeCodes }).where('id', '=', e.id).execute();
      }
    }
  };

  /** Adds route rows the process does not have yet; a category without routes gets one empty row. */
  const writeRoutes = async (tx: Tx, p: Parameters<typeof writeIncluded>[1] & { goods_category_code: string }, routeCodes: string[]) => {
    const existing = await tx.selectFrom('process_route').select(['id', 'route_code']).where('process_id', '=', p.id).execute();
    const wanted: (string | null)[] = routeCodes.length ? routeCodes : [null];
    const drop = existing.filter((e) => !wanted.includes(e.route_code));
    if (drop.length) await tx.deleteFrom('process_route').where('id', 'in', drop.map((d) => d.id)).execute();
    const add = wanted.filter((w) => !existing.some((e) => e.route_code === w));
    if (add.length) {
      await tx
        .insertInto('process_route')
        .values(
          add.map((route_code) => ({
            tenant_id: p.tenant_id,
            client_id: p.client_id,
            installation_id: p.installation_id,
            period_version_id: p.period_version_id,
            library_version_id: p.library_version_id,
            goods_category_code: p.goods_category_code,
            process_id: p.id,
            route_code,
          })) as never,
        )
        .execute();
    }
  };

  // --- read -------------------------------------------------------------------

  router.get('/period-versions/:id/processes', read, async (req, res) => {
    const id = idParam(req.params.id, 'reporting period');
    const list = await withContext(db, contextOf(req), async (tx): Promise<ProcessList> => {
      const v = await loadVersion(tx, id);
      const { details } = await loadVersionProcesses(tx, id);
      return {
        periodVersionId: id,
        libraryVersion: { id: v.library_version_id, code: v.library_code },
        locked: v.locked,
        processes: details.map((d) => ({
          id: d.id,
          position: d.position,
          name: d.name,
          goodsCategory: d.goodsCategory,
          status: d.status,
          activityLevel: d.activityLevel,
          goodsCount: d.goodsCount,
          openChecks: d.openChecks,
        })),
        checks: details.flatMap((d) => d.checks),
      };
    });
    res.json(list);
  });

  router.get('/processes/:id', read, async (req, res) => {
    const id = idParam(req.params.id, 'process');
    const process = await withContext(db, contextOf(req), (tx) => loadProcessDetail(tx, id));
    res.json({ process });
  });

  // --- set-up (admins and consultants) -----------------------------------------------

  // M5-R1: a new process with its category, routes and included precursor categories.
  router.post('/period-versions/:id/processes', configure, async (req, res) => {
    const periodVersionId = idParam(req.params.id, 'reporting period');
    const input = CreateProcessRequest.parse(req.body);
    const process = await withContext(db, contextOf(req, 'Add process'), async (tx) => {
      await assertPeriodWritable(tx, periodVersionId);
      // Serialise process creation per version: positions are picked from what exists.
      const v = await tx.selectFrom('period_version').selectAll().where('id', '=', periodVersionId).forNoKeyUpdate().executeTakeFirstOrThrow();
      const { details, library } = await loadVersionProcesses(tx, periodVersionId);
      const issues = checkSetup(library, input);
      if (issues.length) throw invalid(issues);
      const used = new Set(details.map((d) => d.position));
      const position = Array.from({ length: MAX_PROCESSES }, (_, i) => i + 1).find((n) => !used.has(n));
      if (!position) {
        throw new AppError(409, 'too_many_processes', `A period can have at most ${MAX_PROCESSES} processes, the rows the template has (P1–P${MAX_PROCESSES}).`);
      }
      await checkCategoryCount(tx, periodVersionId, null, input);
      const row = await tx
        .insertInto('production_process')
        .values({
          tenant_id: v.tenant_id,
          client_id: v.client_id,
          installation_id: v.installation_id,
          period_version_id: v.id,
          library_version_id: v.library_version_id,
          position,
          name: input.name,
          goods_category_code: input.goodsCategoryCode,
        } as never)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, UNIQUE));
      await writeRoutes(tx, row, input.routeCodes);
      await writeIncluded(tx, row, input.includedCategories);
      return loadProcessDetail(tx, row.id);
    });
    res.status(201).json({ process });
  });

  // M5-R5: renaming is free; changing the category or dropping routes with data lists what
  // goes and needs confirmation (D22).
  router.patch('/processes/:id', configure, async (req, res) => {
    const id = idParam(req.params.id, 'process');
    const input = UpdateProcessRequest.parse(req.body);
    const categoryChange = input.goodsCategoryCode !== undefined;
    const process = await withContext(db, contextOf(req, categoryChange ? 'Change goods category' : 'Save process'), async (tx) => {
      const row = await loadProcessRow(tx, id, true);
      await assertPeriodWritable(tx, row.period_version_id);
      const current = await loadProcessDetail(tx, id);
      const { library } = await loadVersionProcesses(tx, row.period_version_id, id);
      const newCat = input.goodsCategoryCode ?? row.goods_category_code;
      const changed = newCat !== row.goods_category_code;
      const newCatEntry = library.find((c) => c.code === newCat);
      const precursors = newCatEntry ? precursorsOf(library, newCat) : new Set<string>();

      const next: SetupInput = {
        goodsCategoryCode: newCat,
        routeCodes: input.routeCodes ?? (changed ? [] : current.routes.flatMap((r) => (r.routeCode ? [r.routeCode] : []))),
        // Kept included categories must still be precursors of the new category.
        includedCategories:
          input.includedCategories ??
          current.includedCategories.filter((c) => !changed || precursors.has(c.code)).map((c) => ({ code: c.code, routeCodes: c.routeCodes })),
      };
      const issues = checkSetup(library, next);
      if (issues.length) throw invalid(issues);
      await checkCategoryCount(tx, row.period_version_id, id, next);

      // What goes (M5-R5).
      const keepRoutes = new Set<string | null>(next.routeCodes.length ? next.routeCodes : [null]);
      const droppedRoutes = current.routes.filter((r) => changed || !keepRoutes.has(r.routeCode));
      const oldUnit = current.goodsCategory.unit;
      const unitChanged = changed && newCatEntry!.unit !== oldUnit;
      const droppedGoods = changed ? current.goods : [];
      const droppedIncluded = current.includedCategories.filter((c) => !next.includedCategories.some((n) => n.code === c.code));
      const affected: AffectedRecord[] = [
        ...routeAffected(current, new Set(droppedRoutes.map((r) => r.id))),
        ...droppedGoods.flatMap((g) => goodAffected(g, [], true)),
        ...(await evidenceAffected(tx, droppedGoods.map((g) => ({ table: 'process_good' as const, id: g.id })))),
        ...(changed ? droppedIncluded.map((c) => ({ table: 'process_included_category', id: c.code, label: `Included goods category: ${c.name}` })) : []),
        ...(unitChanged
          ? [
              ...current.internalUses.filter((u) => u.amount).map((u) => ({ table: 'process_internal_use', id: u.id, label: `Consumed by ${u.consumerName}` })),
              ...(current.nonCbam ? [{ table: 'production_process', id, label: 'Consumed for non-CBAM goods' }] : []),
            ]
          : []),
      ];
      requireConfirmation(affected, input.confirm, changed ? 'Changing the goods category' : 'Removing these routes');

      await removeEvidenceLinks(tx, droppedGoods.map((g) => ({ table: 'process_good' as const, id: g.id })));
      if (droppedGoods.length) await tx.deleteFrom('process_good').where('id', 'in', droppedGoods.map((g) => g.id)).execute();
      if (droppedRoutes.length) await tx.deleteFrom('process_route').where('id', 'in', droppedRoutes.map((r) => r.id)).execute();
      if (unitChanged) await tx.deleteFrom('process_internal_use').where('process_id', '=', id).execute();
      // Drop included categories before the category changes: the database checks the rest stay precursors.
      if (droppedIncluded.length) {
        await tx
          .deleteFrom('process_included_category')
          .where('process_id', '=', id)
          .where('goods_category_code', 'in', droppedIncluded.map((c) => c.code))
          .execute();
      }
      const updated = await tx
        .updateTable('production_process')
        .set({
          ...(input.name !== undefined && { name: input.name }),
          goods_category_code: newCat,
          ...(unitChanged && amountColumns('non_cbam', null)),
          status: 'draft',
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, UNIQUE));
      await writeRoutes(tx, updated, next.routeCodes);
      await writeIncluded(tx, updated, next.includedCategories);
      return loadProcessDetail(tx, id);
    });
    res.json({ process });
  });

  // M5-R6: a process with data is deleted only after confirmation; every row removed has its
  // own audit entry under "Delete process".
  router.delete('/processes/:id', configure, async (req, res) => {
    const id = idParam(req.params.id, 'process');
    const { confirm } = ConfirmQuery.parse(req.query);
    await withContext(db, contextOf(req, 'Delete process'), async (tx) => {
      const row = await loadProcessRow(tx, id, true);
      await assertPeriodWritable(tx, row.period_version_id);
      const p = await loadProcessDetail(tx, id);
      const consumedHere = await tx
        .selectFrom('process_internal_use as u')
        .innerJoin('production_process as s', 's.id', 'u.process_id')
        .select(['u.id', 's.name', 'u.amount_value', 'u.amount_unit'])
        .where('u.consumer_process_id', '=', id)
        .where('u.amount_value', 'is not', null)
        .execute();
      const records = [{ table: 'production_process' as const, id }, ...p.goods.map((g) => ({ table: 'process_good' as const, id: g.id }))];
      const affected: AffectedRecord[] = [
        ...routeAffected(p, new Set(p.routes.map((r) => r.id))),
        ...p.goods.flatMap((g) => goodAffected(g)),
        ...p.internalUses.filter((u) => u.amount).map((u) => ({ table: 'process_internal_use', id: u.id, label: `Consumed by ${u.consumerName}` })),
        ...consumedHere.map((u) => ({ table: 'process_internal_use', id: u.id, label: `${u.name}: amount consumed by this process` })),
        ...(p.nonCbam ? [{ table: 'production_process', id, label: 'Consumed for non-CBAM goods' }] : []),
        ...(await evidenceAffected(tx, records)),
        ...(await Promise.all(dependents.map((d) => d.list(tx, id)))).flat(),
      ];
      requireConfirmation(affected, confirm, 'Deleting this process');
      for (const d of dependents) await d.remove(tx, id);
      await removeEvidenceLinks(tx, records);
      await tx.deleteFrom('production_process').where('id', '=', id).execute();
    });
    res.status(204).end();
  });

  // D20: only with no critical check open; only admins and consultants.
  router.post('/processes/:id/complete', configure, async (req, res) => {
    const id = idParam(req.params.id, 'process');
    const process = await withContext(db, contextOf(req, 'Mark process complete'), async (tx) => {
      const row = await loadProcessRow(tx, id, true);
      await assertPeriodWritable(tx, row.period_version_id);
      const p = await loadProcessDetail(tx, id);
      if (!canComplete(p.checks)) {
        const critical = p.checks.filter((c) => c.severity === 'critical');
        throw new AppError(
          409,
          'checks_open',
          `This process can't be marked complete: ${critical.length === 1 ? '1 critical check is' : `${critical.length} critical checks are`} open.`,
          { checks: critical },
        );
      }
      if (p.status !== 'complete') await tx.updateTable('production_process').set({ status: 'complete' }).where('id', '=', id).execute();
      return loadProcessDetail(tx, id);
    });
    res.json({ process });
  });

  // M5-R2 / AT1: the CN code is in the pinned library and belongs to the main category.
  router.post('/processes/:id/goods', configure, async (req, res) => {
    const id = idParam(req.params.id, 'process');
    const input = GoodInput.parse(req.body);
    const process = await withContext(db, contextOf(req, 'Add good'), async (tx) => {
      const row = await loadProcessRow(tx, id, true);
      await assertPeriodWritable(tx, row.period_version_id);
      await checkCnCode(tx, row, input.cnCode);
      await tx
        .insertInto('process_good')
        .values({
          tenant_id: row.tenant_id,
          client_id: row.client_id,
          installation_id: row.installation_id,
          period_version_id: row.period_version_id,
          library_version_id: row.library_version_id,
          goods_category_code: row.goods_category_code,
          process_id: id,
          cn_code: input.cnCode,
          product_name: input.productName ?? null,
        } as never)
        .execute()
        .catch((e) => mapDbError(e, UNIQUE));
      await backToDraft(tx, id);
      return loadProcessDetail(tx, id);
    });
    res.status(201).json({ process });
  });

  const loadGood = async (tx: Tx, id: string) => {
    const good = await tx.selectFrom('process_good').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!good) throw notFound('good');
    const row = await loadProcessRow(tx, good.process_id, true);
    await assertPeriodWritable(tx, good.period_version_id);
    return { good, row };
  };

  const checkCnCode = async (tx: Tx, row: { library_version_id: string; goods_category_code: string }, cnCode: string) => {
    const cn = await tx
      .selectFrom('cn_code as c')
      .innerJoin('goods_category as g', (j) => j.onRef('g.library_version_id', '=', 'c.library_version_id').onRef('g.code', '=', 'c.goods_category_code'))
      .select(['c.goods_category_code', 'g.name'])
      .where('c.library_version_id', '=', row.library_version_id)
      .where('c.code', '=', cnCode)
      .executeTakeFirst();
    if (!cn) throw invalid([{ path: ['cnCode'], message: `CN code ${cnCode} is not a CBAM good in the reference library this period uses.` }]);
    if (cn.goods_category_code !== row.goods_category_code) {
      const own = await tx
        .selectFrom('goods_category')
        .select('name')
        .where('library_version_id', '=', row.library_version_id)
        .where('code', '=', row.goods_category_code)
        .executeTakeFirstOrThrow();
      throw invalid([{ path: ['cnCode'], message: `CN code ${cnCode} is ${cn.name}, not ${own.name}. Add it to a process for ${cn.name}.` }]);
    }
  };

  router.patch('/process-goods/:id', configure, async (req, res) => {
    const id = idParam(req.params.id, 'good');
    const input = GoodPatch.parse(req.body);
    const process = await withContext(db, contextOf(req, 'Save good'), async (tx) => {
      const { good, row } = await loadGood(tx, id);
      if (input.cnCode !== undefined) await checkCnCode(tx, row, input.cnCode);
      await tx
        .updateTable('process_good')
        .set({
          ...(input.cnCode !== undefined && { cn_code: input.cnCode }),
          ...(input.productName !== undefined && { product_name: input.productName }),
        })
        .where('id', '=', id)
        .execute()
        .catch((e) => mapDbError(e, UNIQUE));
      await backToDraft(tx, good.process_id);
      return loadProcessDetail(tx, good.process_id);
    });
    res.json({ process });
  });

  router.delete('/process-goods/:id', configure, async (req, res) => {
    const id = idParam(req.params.id, 'good');
    const { confirm } = ConfirmQuery.parse(req.query);
    const process = await withContext(db, contextOf(req, 'Delete good'), async (tx) => {
      const { good } = await loadGood(tx, id);
      const p = await loadProcessDetail(tx, good.process_id);
      const records = [{ table: 'process_good' as const, id }];
      const g = p.goods.find((x) => x.id === id)!;
      requireConfirmation(goodAffected(g, await evidenceAffected(tx, records)), confirm, 'Deleting this good');
      await removeEvidenceLinks(tx, records);
      await tx.deleteFrom('process_good').where('id', '=', id).execute();
      await backToDraft(tx, good.process_id);
      return loadProcessDetail(tx, good.process_id);
    });
    res.json({ process });
  });

  // --- data (admins, consultants, contributors of the installation) --------------------

  // D_Processes (a), (c), (d): production per route, consumption by other processes, non-CBAM.
  router.put('/processes/:id/production', enter, async (req, res) => {
    const id = idParam(req.params.id, 'process');
    const input = ProductionRequest.parse(req.body);
    const process = await withContext(db, contextOf(req, 'Save production'), async (tx) => {
      const row = await loadProcessRow(tx, id, true);
      await assertPeriodWritable(tx, row.period_version_id);
      const p = await loadProcessDetail(tx, id);
      const unit = p.goodsCategory.unit;
      const others = new Set(p.otherProcesses.map((o) => o.id));
      const issues: Issue[] = [
        ...input.routes.flatMap((r, i) => [
          ...(p.routes.some((x) => x.id === r.routeId) ? [] : [{ path: ['routes', i, 'routeId'], message: 'This route is not part of the process.' }]),
          ...checkAmountUnit(r.amount, unit, ['routes', i, 'amount', 'unit']),
        ]),
        ...checkAmountUnit(input.nonCbam, unit, ['nonCbam', 'unit']),
        ...input.internalUses.flatMap((u, i) => [
          ...(others.has(u.consumerProcessId) ? [] : [{ path: ['internalUses', i, 'consumerProcessId'], message: 'Choose another process of this period.' }]),
          ...checkAmountUnit(u.amount, unit, ['internalUses', i, 'amount', 'unit']),
        ]),
      ];
      if (issues.length) throw invalid(issues);

      for (const r of input.routes) {
        await tx.updateTable('process_route').set(amountColumns('amount', r.amount)).where('id', '=', r.routeId).execute();
      }
      await tx.updateTable('production_process').set({ ...amountColumns('non_cbam', input.nonCbam), status: 'draft' }).where('id', '=', id).execute();
      const keep = input.internalUses.map((u) => u.consumerProcessId);
      let del = tx.deleteFrom('process_internal_use').where('process_id', '=', id);
      if (keep.length) del = del.where('consumer_process_id', 'not in', keep);
      await del.execute();
      for (const u of input.internalUses) {
        const existing = p.internalUses.find((x) => x.consumerProcessId === u.consumerProcessId);
        if (existing) {
          await tx.updateTable('process_internal_use').set(amountColumns('amount', u.amount)).where('id', '=', existing.id).execute();
        } else {
          await tx
            .insertInto('process_internal_use')
            .values({
              tenant_id: row.tenant_id,
              client_id: row.client_id,
              installation_id: row.installation_id,
              period_version_id: row.period_version_id,
              library_version_id: row.library_version_id,
              process_id: id,
              consumer_process_id: u.consumerProcessId,
              ...amountColumns('amount', u.amount),
            } as never)
            .execute();
        }
      }
      return loadProcessDetail(tx, id);
    });
    res.json({ process });
  });

  // Quantities of a good and its qualifying parameters (spec 4.3, M5-R4, D18).
  router.put('/process-goods/:id/data', enter, async (req, res) => {
    const id = idParam(req.params.id, 'good');
    const input = GoodDataRequest.parse(req.body);
    const process = await withContext(db, contextOf(req, 'Save good data'), async (tx) => {
      const { good, row } = await loadGood(tx, id);
      const p = await loadProcessDetail(tx, row.id);
      const unit = p.goodsCategory.unit;
      const defs = new Map(p.qualifyingParameters.map((d) => [d.position, d]));
      const issues: Issue[] = [
        ...checkAmountUnit(input.produced, unit, ['produced', 'unit']),
        ...checkAmountUnit(input.soldEu, unit, ['soldEu', 'unit']),
        ...checkAmountUnit(input.soldOther, unit, ['soldOther', 'unit']),
      ];
      input.parameters.forEach((v, i) => {
        const d = defs.get(v.position);
        const path = ['parameters', i];
        if (!d) return issues.push({ path: [...path, 'position'], message: 'This goods category has no such qualifying parameter.' });
        if (v.text === null && v.quantity === null) return;
        if (d.valueKind === 'number') {
          if (!v.quantity) return issues.push({ path: [...path, 'quantity'], message: `Enter a number for ${d.name}.` });
          const dim = normaliseQuantity(v.quantity).siUnit === 't/t' ? 'mass_ratio' : 'fraction';
          if (dim !== d.dimension) {
            issues.push({ path: [...path, 'quantity', 'unit'], message: d.dimension === 'mass_ratio' ? 'Enter this as t/t or kg/t.' : 'Enter this as % or a fraction.' });
          }
        } else if (v.text === null) {
          issues.push({ path: [...path, 'text'], message: `Enter ${d.name}.` });
        } else if (d.valueKind === 'choice' && !d.choices!.includes(v.text)) {
          issues.push({ path: [...path, 'text'], message: `Choose one of: ${d.choices!.join(', ')}.` });
        }
      });
      if (issues.length) throw invalid(issues);

      await tx
        .updateTable('process_good')
        .set({ ...amountColumns('produced', input.produced), ...amountColumns('sold_eu', input.soldEu), ...amountColumns('sold_other', input.soldOther) })
        .where('id', '=', id)
        .execute();
      const values = input.parameters.filter((v) => v.text !== null || v.quantity !== null);
      const keep = values.map((v) => v.position);
      let del = tx.deleteFrom('process_good_parameter').where('good_id', '=', id);
      if (keep.length) del = del.where('position', 'not in', keep);
      await del.execute();
      const existing = p.goods.find((g) => g.id === id)!.parameters;
      for (const v of values) {
        const cols = { value_text: v.text, ...amountColumns('value', v.quantity) };
        // An unchanged value writes no audit entry: the trigger skips updates of metadata only.
        if (existing.some((e) => e.position === v.position)) {
          await tx.updateTable('process_good_parameter').set(cols).where('good_id', '=', id).where('position', '=', v.position).execute();
        } else {
          await tx
            .insertInto('process_good_parameter')
            .values({
              tenant_id: good.tenant_id,
              client_id: good.client_id,
              installation_id: good.installation_id,
              period_version_id: good.period_version_id,
              library_version_id: good.library_version_id,
              goods_category_code: good.goods_category_code,
              good_id: id,
              position: v.position,
              ...cols,
            } as never)
            .execute();
        }
      }
      await backToDraft(tx, row.id);
      return loadProcessDetail(tx, row.id);
    });
    res.json({ process });
  });

  return router;
}

export type { ProcessDetail };

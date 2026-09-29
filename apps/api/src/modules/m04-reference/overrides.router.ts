import { Router } from 'express';
import { z } from 'zod';
import {
  Decimal,
  type FactorKind,
  type FactorOverride,
  OverrideDecision,
  OverrideInput,
  OverrideRejection,
  type OverrideStatus,
  type SeeComponent,
  UNITS,
  type UnitId,
  baseUnit,
  factorKey,
  toBase,
} from '@cbam/shared';
import type { Selectable } from 'kysely';
import type { ClientFactorOverride } from '../../db-types';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { mapDbError } from '../../platform/db-errors';
import { type Db, type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { currentVersion, factorDto, loadFactors } from './data';

const Id = z.uuid();
const notFound = (what: string) => new AppError(404, 'not_found', `This ${what} does not exist or you do not have access to it.`);
const idParam = (raw: unknown, what: string): string => {
  const r = Id.safeParse(raw);
  if (!r.success) throw notFound(what);
  return r.data;
};

const OVERRIDE_UNIQUE = {
  client_factor_override_live: 'This client already has a proposed or approved override for this factor. Withdraw it first.',
};

type OverrideRow = Selectable<ClientFactorOverride>;

/**
 * M4-R5: client-specific factor overrides. Consultants and admins propose; the platform admin
 * approves or rejects; the proposer (or admin) withdraws. Every override is flagged as such
 * wherever it is shown, next to the library value it replaces.
 */
export function overridesRouter({ db }: { db: Db }): Router {
  const router = Router();
  router.use(['/clients/:id/factor-overrides', '/factor-overrides'], requireAuth);

  const loadClient = async (tx: Tx, id: string) => {
    const c = await tx.selectFrom('client').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!c) throw notFound('client');
  };

  const loadOverride = async (tx: Tx, id: string) => {
    const row = await tx
      .selectFrom('client_factor_override as o')
      .innerJoin('client as c', 'c.id', 'o.client_id')
      .selectAll('o')
      .where('o.id', '=', id)
      .where('c.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw notFound('override');
    return row;
  };

  const toDtos = async (tx: Tx, rows: OverrideRow[]): Promise<FactorOverride[]> => {
    const current = await currentVersion(tx);
    const library = new Map(current ? (await loadFactors(tx, current.id)).map((f) => [factorKey(factorDto(f)), factorDto(f)]) : []);
    const userIds = [...new Set(rows.flatMap((r) => [r.created_by, r.decided_by]).filter((u): u is string => !!u))];
    const names = new Map(
      userIds.length
        ? (await tx.selectFrom('app_user').select(['id', 'display_name']).where('id', 'in', userIds).execute()).map((u) => [u.id, u.display_name])
        : [],
    );
    return rows.map((r) => {
      const key = {
        kind: r.kind as FactorKind,
        subject: r.subject,
        countryCode: r.country_code?.trimEnd() ?? null,
        region: r.region,
        year: r.year,
        component: r.component as SeeComponent | null,
      };
      const lib = library.get(factorKey(key));
      return {
        id: r.id,
        clientId: r.client_id,
        ...key,
        value: new Decimal(r.value).toString(),
        unit: r.unit,
        valueSi: new Decimal(r.value_si).toString(),
        siUnit: r.si_unit,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        source: r.source,
        justification: r.justification,
        status: r.status as OverrideStatus,
        proposedBy: r.created_by,
        proposedByName: names.get(r.created_by) ?? null,
        proposedAt: r.created_at.toISOString(),
        decidedByName: r.decided_by ? (names.get(r.decided_by) ?? null) : null,
        decidedAt: r.decided_at?.toISOString() ?? null,
        decisionNote: r.decision_note,
        libraryValue: lib && current ? { value: lib.value, unit: lib.unit, versionCode: current.code } : null,
      };
    });
  };

  router.get('/clients/:id/factor-overrides', async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const overrides = await withContext(db, contextOf(req), async (tx) => {
      await loadClient(tx, clientId);
      const rows = await tx
        .selectFrom('client_factor_override')
        .selectAll()
        .where('client_id', '=', clientId)
        .orderBy('created_at', 'desc')
        .execute();
      return toDtos(tx, rows);
    });
    res.json({ overrides });
  });

  router.post('/clients/:id/factor-overrides', requirePermission('overrides.propose'), async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const input = OverrideInput.parse(req.body);
    const unit = input.unit as UnitId;
    const ctx = contextOf(req, 'Propose factor override');
    const [override] = await withContext(db, ctx, async (tx) => {
      await loadClient(tx, clientId);
      const row = await tx
        .insertInto('client_factor_override')
        .values({
          tenant_id: ctx.tenantId,
          client_id: clientId,
          kind: input.kind,
          subject: input.subject,
          country_code: input.countryCode ?? null,
          region: input.region ?? null,
          year: input.year ?? null,
          component: input.component ?? null,
          value: input.value,
          unit: input.unit,
          value_si: toBase(input.value, unit).toString(),
          si_unit: baseUnit(UNITS[unit].dimension),
          valid_from: input.validFrom,
          valid_to: input.validTo ?? null,
          source: input.source,
          justification: input.justification,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, OVERRIDE_UNIQUE));
      return toDtos(tx, [row]);
    });
    res.status(201).json({ override });
  });

  const transition = (status: OverrideStatus, action: string, from: OverrideStatus[]) =>
    async (req: import('express').Request, res: import('express').Response) => {
      const id = idParam(req.params.id, 'override');
      const note =
        status === 'rejected' ? OverrideRejection.parse(req.body).note : status === 'approved' ? (OverrideDecision.parse(req.body).note ?? null) : null;
      const [override] = await withContext(db, contextOf(req, action), async (tx) => {
        const o = await loadOverride(tx, id);
        if (!from.includes(o.status as OverrideStatus)) {
          throw new AppError(409, 'wrong_status', `This override is ${o.status} and cannot be ${status === 'withdrawn' ? 'withdrawn' : status}.`);
        }
        const auth = req.auth!.user;
        if (status === 'withdrawn' && auth.role !== 'platform_admin' && o.created_by !== auth.id) {
          throw new AppError(403, 'forbidden', 'Only the consultant who proposed this override, or a platform admin, can withdraw it.');
        }
        const row = await tx
          .updateTable('client_factor_override')
          .set({ status, ...(status !== 'withdrawn' && { decision_note: note }) })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()
          .catch((e) => mapDbError(e, OVERRIDE_UNIQUE));
        return toDtos(tx, [row]);
      });
      res.json({ override });
    };

  router.post('/factor-overrides/:id/approve', requirePermission('overrides.decide'), transition('approved', 'Approve factor override', ['proposed']));
  router.post('/factor-overrides/:id/reject', requirePermission('overrides.decide'), transition('rejected', 'Reject factor override', ['proposed']));
  router.post(
    '/factor-overrides/:id/withdraw',
    requirePermission('overrides.propose'),
    transition('withdrawn', 'Withdraw factor override', ['proposed', 'approved']),
  );

  return router;
}

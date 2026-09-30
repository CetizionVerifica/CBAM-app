import { Router } from 'express';
import { z } from 'zod';
import {
  PERIOD_TRANSITIONS,
  PeriodInput,
  type PeriodDetail,
  type PeriodStatus,
  type PeriodStatusChange,
  type PeriodSummary,
  PeriodTransitionRequest,
  type PeriodVersionSummary,
} from '@cbam/shared';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { type Db, type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { currentVersion } from '../m04-reference/data';
import { type PeriodHooks, emptyPeriodHooks } from './hooks';
import { lockedError } from './lock';

const Id = z.uuid();

const notFound = (what: string) => new AppError(404, 'not_found', `This ${what} does not exist or you do not have access to it.`);

const idParam = (raw: unknown, what: string): string => {
  const r = Id.safeParse(raw);
  if (!r.success) throw notFound(what);
  return r.data;
};

const STATUS_LABEL: Record<PeriodStatus, string> = {
  draft: 'a draft',
  in_review: 'in review',
  approved: 'approved',
  issued: 'issued',
};

/** M3-R1: the database's exclusion constraint answers for overlaps, including races. */
function mapPeriodDbError(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err.code === '23P01' && err.constraint === 'reporting_period_no_overlap') {
    throw new AppError(409, 'overlap', 'This installation already has a reporting period that overlaps these dates.', undefined, [
      { path: ['startDate'], message: 'These dates overlap another reporting period of this installation.' },
    ]);
  }
  throw e;
}

/**
 * M3 — reporting period manager: open, clone, version and move periods through their
 * status. Every query runs under the caller's context, so RLS decides what exists for them
 * (G1); the database triggers repeat the status and lock rules (G4).
 */
export function periodsRouter({ db, hooks = emptyPeriodHooks() }: { db: Db; hooks?: PeriodHooks }): Router {
  const router = Router();
  router.use(['/installations/:id/periods', '/periods', '/period-versions'], requireAuth);
  const manage = requirePermission('periods.manage');

  // --- loaders ---------------------------------------------------------------

  const loadInstallation = async (tx: Tx, id: string) => {
    const row = await tx
      .selectFrom('installation')
      .select(['id', 'client_id', 'tenant_id'])
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw notFound('installation');
    return row;
  };

  const loadPeriod = async (tx: Tx, id: string, lock = false) => {
    let q = tx
      .selectFrom('reporting_period as p')
      .innerJoin('installation as i', 'i.id', 'p.installation_id')
      .innerJoin('client as c', 'c.id', 'p.client_id')
      .selectAll('p')
      .select(['i.name_en as installation_name', 'c.legal_name as client_name'])
      .where('p.id', '=', id)
      .where('i.deleted_at', 'is', null)
      .where('c.deleted_at', 'is', null);
    if (lock) q = q.forUpdate('p');
    const row = await q.executeTakeFirst();
    if (!row) throw notFound('reporting period');
    return row;
  };

  const versionsQuery = (tx: Tx) =>
    tx
      .selectFrom('period_version as v')
      .innerJoin('library_version as l', 'l.id', 'v.library_version_id')
      .innerJoin('template_version as t', 't.id', 'v.template_version_id')
      .leftJoin('period_version as b', 'b.id', 'v.based_on_version_id')
      .selectAll('v')
      .select(['l.code as library_code', 't.code as template_code', 'b.version_no as based_on_no']);

  type VersionRow = Awaited<ReturnType<ReturnType<typeof versionsQuery>['execute']>>[number];

  const versionDto = (v: VersionRow): PeriodVersionSummary => ({
    id: v.id,
    versionNo: v.version_no,
    status: v.status as PeriodStatus,
    libraryVersion: { id: v.library_version_id, code: v.library_code },
    templateVersion: { id: v.template_version_id, code: v.template_code },
    basedOnVersionNo: v.based_on_no,
    approvedAt: v.approved_at?.toISOString() ?? null,
    issuedAt: v.issued_at?.toISOString() ?? null,
    createdAt: v.created_at.toISOString(),
  });

  /** The versions new periods pin (G8): the current library and the newest template. */
  const currentPins = async (tx: Tx) => {
    const library = await currentVersion(tx);
    if (!library) {
      throw new AppError(409, 'no_library', 'No library version is published yet. A platform admin must publish one before periods can be opened.');
    }
    const template = await tx
      .selectFrom('template_version')
      .select('id')
      .orderBy('released_on', 'desc')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!template) throw new AppError(409, 'no_template', 'No template version is registered yet.');
    return { library_version_id: library.id, template_version_id: template.id };
  };

  const insertPeriod = async (tx: Tx, inst: { id: string; client_id: string; tenant_id: string }, input: PeriodInput) => {
    const period = await tx
      .insertInto('reporting_period')
      .values({
        tenant_id: inst.tenant_id,
        client_id: inst.client_id,
        installation_id: inst.id,
        start_date: input.startDate,
        end_date: input.endDate,
        justification: input.justification ?? null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(mapPeriodDbError);
    const version = await tx
      .insertInto('period_version')
      .values({
        tenant_id: inst.tenant_id,
        client_id: inst.client_id,
        installation_id: inst.id,
        period_id: period.id,
        version_no: 1,
        ...(await currentPins(tx)),
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { periodId: period.id, versionId: version.id };
  };

  const periodDetail = async (tx: Tx, id: string): Promise<PeriodDetail> => {
    const p = await loadPeriod(tx, id);
    const versions = (await versionsQuery(tx).where('v.period_id', '=', id).orderBy('v.version_no', 'desc').execute()).map(versionDto);
    const history = await tx
      .selectFrom('period_status_change as h')
      .innerJoin('period_version as v', 'v.id', 'h.period_version_id')
      .leftJoin('app_user as u', 'u.id', 'h.created_by')
      .select(['h.id', 'v.version_no', 'h.from_status', 'h.to_status', 'h.reason', 'h.created_at', 'u.display_name'])
      .where('v.period_id', '=', id)
      .orderBy('h.created_at', 'desc')
      .orderBy('h.id')
      .execute();
    const latest = versions[0]!;
    return {
      id: p.id,
      clientId: p.client_id,
      clientName: p.client_name,
      installationId: p.installation_id,
      installationName: p.installation_name,
      startDate: p.start_date,
      endDate: p.end_date,
      justification: p.justification,
      versionCount: versions.length,
      versions,
      datesEditable: versions.length === 1 && latest.status === 'draft',
      history: history.map(
        (h): PeriodStatusChange => ({
          id: h.id,
          versionNo: h.version_no,
          fromStatus: h.from_status as PeriodStatus | null,
          toStatus: h.to_status as PeriodStatus,
          reason: h.reason,
          changedAt: h.created_at.toISOString(),
          changedBy: h.display_name,
        }),
      ),
    };
  };

  // --- periods of an installation ----------------------------------------------

  router.get('/installations/:id/periods', async (req, res) => {
    const installationId = idParam(req.params.id, 'installation');
    const periods = await withContext(db, contextOf(req), async (tx) => {
      await loadInstallation(tx, installationId);
      const rows = await tx
        .selectFrom('reporting_period')
        .selectAll()
        .where('installation_id', '=', installationId)
        .orderBy('start_date', 'desc')
        .execute();
      if (rows.length === 0) return [];
      const versions = await versionsQuery(tx)
        .where(
          'v.period_id',
          'in',
          rows.map((r) => r.id),
        )
        .orderBy('v.version_no', 'desc')
        .execute();
      return rows.map((r): PeriodSummary => {
        const own = versions.filter((v) => v.period_id === r.id);
        return {
          id: r.id,
          installationId: r.installation_id,
          startDate: r.start_date,
          endDate: r.end_date,
          justification: r.justification,
          latest: versionDto(own[0]!),
          versionCount: own.length,
        };
      });
    });
    res.json({ periods });
  });

  // M3-R1, R2: open a period; version 1 pins the current library and template (G8).
  router.post('/installations/:id/periods', manage, async (req, res) => {
    const installationId = idParam(req.params.id, 'installation');
    const input = PeriodInput.parse(req.body);
    const period = await withContext(db, contextOf(req, 'Open reporting period'), async (tx) => {
      const inst = await loadInstallation(tx, installationId);
      const { periodId } = await insertPeriod(tx, inst, input);
      return periodDetail(tx, periodId);
    });
    res.status(201).json({ period });
  });

  // --- one period ---------------------------------------------------------------

  router.get('/periods/:id', async (req, res) => {
    const id = idParam(req.params.id, 'reporting period');
    const period = await withContext(db, contextOf(req), (tx) => periodDetail(tx, id));
    res.json({ period });
  });

  // Dates and justification: only while the period has one version, still a draft.
  router.patch('/periods/:id', manage, async (req, res) => {
    const id = idParam(req.params.id, 'reporting period');
    const input = PeriodInput.parse(req.body);
    const period = await withContext(db, contextOf(req, 'Save period dates'), async (tx) => {
      await loadPeriod(tx, id, true);
      // Share-lock the versions so a status change cannot slip in between this check and the
      // update (independent review M3 F1); the database guard takes the same lock.
      await tx.selectFrom('period_version').select('id').where('period_id', '=', id).forShare().execute();
      const current = await periodDetail(tx, id);
      if (!current.datesEditable) {
        throw new AppError(409, 'locked', 'The dates are fixed once the period is submitted for review or has a second version.');
      }
      await tx
        .updateTable('reporting_period')
        .set({ start_date: input.startDate, end_date: input.endDate, justification: input.justification ?? null })
        .where('id', '=', id)
        .execute()
        .catch(mapPeriodDbError);
      return periodDetail(tx, id);
    });
    res.json({ period });
  });

  // M3-R5: after issue, changes go into version n+1, which starts from version n's data
  // and pins. Version n and its outputs stay as they were.
  router.post('/periods/:id/versions', manage, async (req, res) => {
    const id = idParam(req.params.id, 'reporting period');
    const period = await withContext(db, contextOf(req, 'Create new version'), async (tx) => {
      const p = await loadPeriod(tx, id, true); // serialises concurrent requests
      const prev = await tx
        .selectFrom('period_version')
        .selectAll()
        .where('period_id', '=', id)
        .orderBy('version_no', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      if (prev.status !== 'issued') {
        throw new AppError(
          409,
          'not_issued',
          `Version ${prev.version_no} is ${STATUS_LABEL[prev.status as PeriodStatus]}. Make changes there; a new version is needed only after issue.`,
        );
      }
      const next = await tx
        .insertInto('period_version')
        .values({
          tenant_id: p.tenant_id,
          client_id: p.client_id,
          installation_id: p.installation_id,
          period_id: id,
          version_no: prev.version_no + 1,
          based_on_version_id: prev.id,
          library_version_id: prev.library_version_id,
          template_version_id: prev.template_version_id,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const copy of hooks.versionCopiers) await copy(tx, { periodVersionId: prev.id }, { periodVersionId: next.id });
      return periodDetail(tx, id);
    });
    res.status(201).json({ period });
  });

  // M3-R6: a new period on the same installation with the set-up of this one (never its
  // activity data). The set-up copiers (M5, later M6) say what they could not copy (D23).
  router.post('/periods/:id/clone', manage, async (req, res) => {
    const id = idParam(req.params.id, 'reporting period');
    const input = PeriodInput.parse(req.body);
    const result = await withContext(db, contextOf(req, 'Clone period'), async (tx) => {
      const source = await loadPeriod(tx, id);
      const from = await tx
        .selectFrom('period_version')
        .select('id')
        .where('period_id', '=', id)
        .orderBy('version_no', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      const inst = await loadInstallation(tx, source.installation_id);
      const created = await insertPeriod(tx, inst, input);
      const notes: string[] = [];
      for (const copy of hooks.setupCopiers) notes.push(...((await copy(tx, { periodVersionId: from.id }, { periodVersionId: created.versionId })) ?? []));
      return { period: await periodDetail(tx, created.periodId), notes };
    });
    res.status(201).json(result);
  });

  // --- status (M3-R3, R7) ---------------------------------------------------------

  router.post('/period-versions/:id/transitions', async (req, res) => {
    const id = idParam(req.params.id, 'reporting period');
    const body = PeriodTransitionRequest.parse(req.body);
    const t = PERIOD_TRANSITIONS[body.action];
    const role = req.auth!.user.role;
    if (!t.roles.includes(role)) {
      throw new AppError(
        403,
        'forbidden',
        body.action === 'reopen' ? 'Only a consultant can return a period to draft.' : 'Your role does not allow this action.',
      );
    }
    const period = await withContext(db, contextOf(req, t.label, body.reason ?? undefined), async (tx) => {
      const v = await tx.selectFrom('period_version').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!v) throw notFound('reporting period');
      const status = v.status as PeriodStatus;
      if (!t.from.includes(status)) {
        if (status === 'issued') throw lockedError('issued');
        throw new AppError(409, 'invalid_transition', `This period is ${STATUS_LABEL[status]}, so you can't ${t.label.toLowerCase()} now.`);
      }
      if (body.action === 'approve') {
        const blockers = (await Promise.all(hooks.approvalGuards.map((g) => g(tx, id)))).flat();
        if (blockers.length > 0) {
          throw new AppError(409, 'approval_blocked', `You can't approve this period: ${blockers.map((b) => b.message).join(' ')}`, { blockers });
        }
      }
      await tx.updateTable('period_version').set({ status: t.to }).where('id', '=', id).execute();
      return periodDetail(tx, v.period_id);
    });
    res.json({ period });
  });

  return router;
}

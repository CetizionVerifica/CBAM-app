import { Router } from 'express';
import { z } from 'zod';
import { VerificationApproval, type VerificationDetail, VerificationInput, can } from '@cbam/shared';
import { contextOf, requireAuth } from '../../platform/auth';
import { type Db, type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { assertPeriodWritable } from '../m03-periods';

const Id = z.uuid();
const notFound = () => new AppError(404, 'not_found', 'This reporting period does not exist or you do not have access to it.');

// camelCase field ↔ column, in template order (sheet A section 3, I37–I53).
const COLUMNS = {
  verifierName: 'verifier_name',
  verifierStreet: 'verifier_street',
  verifierCity: 'verifier_city',
  verifierPostcode: 'verifier_postcode',
  verifierCountryCode: 'verifier_country_code',
  repName: 'rep_name',
  repEmail: 'rep_email',
  repPhone: 'rep_phone',
  repFax: 'rep_fax',
  accreditationMemberState: 'accreditation_member_state',
  accreditationBody: 'accreditation_body',
  accreditationRegNo: 'accreditation_reg_no',
  siteVisitDate: 'site_visit_date',
  opinion: 'opinion',
  findings: 'findings',
} as const;

/**
 * M13-R7 — verifier details, site visit, opinion and findings per period version, plus the
 * consultant's and the client's approval. Period data: locked with the period (G4).
 */
export function verificationRouter({ db }: { db: Db }): Router {
  const router = Router();
  router.use('/period-versions/:id/verification', requireAuth);

  const loadVersion = async (tx: Tx, raw: unknown) => {
    const id = Id.safeParse(raw);
    if (!id.success) throw notFound();
    const v = await tx.selectFrom('period_version').select(['id', 'tenant_id', 'client_id', 'installation_id']).where('id', '=', id.data).executeTakeFirst();
    if (!v) throw notFound();
    return v;
  };

  const detail = async (tx: Tx, versionId: string): Promise<VerificationDetail> => {
    const r = await tx.selectFrom('verification').selectAll().where('period_version_id', '=', versionId).executeTakeFirst();
    const userIds = [r?.consultant_approved_by, r?.client_approved_by].filter((x): x is string => !!x);
    const names = new Map(
      userIds.length
        ? (await tx.selectFrom('app_user').select(['id', 'display_name']).where('id', 'in', userIds).execute()).map((u) => [u.id, u.display_name])
        : [],
    );
    const out = Object.fromEntries(
      Object.entries(COLUMNS).map(([k, col]) => {
        const v = r?.[col as keyof typeof r] ?? (k === 'findings' ? [] : null);
        return [k, v instanceof Date ? v.toISOString() : v];
      }),
    ) as Omit<VerificationDetail, 'id' | 'periodVersionId' | 'consultantApproval' | 'clientApproval'>;
    return {
      id: r?.id ?? null,
      periodVersionId: versionId,
      ...out,
      consultantApproval: r?.consultant_approved_at ? { at: r.consultant_approved_at.toISOString(), by: names.get(r.consultant_approved_by!) ?? null } : null,
      clientApproval: r?.client_approved_at ? { at: r.client_approved_at.toISOString(), by: names.get(r.client_approved_by!) ?? null } : null,
    };
  };

  router.get('/period-versions/:id/verification', async (req, res) => {
    const verification = await withContext(db, contextOf(req), async (tx) => detail(tx, (await loadVersion(tx, req.params.id)).id));
    res.json({ verification });
  });

  // Create or update (partial). Any change withdraws both approvals (DB trigger).
  router.put('/period-versions/:id/verification', async (req, res) => {
    if (!can(req.auth!.user.role, 'verification.edit')) throw new AppError(403, 'forbidden', 'Your role does not allow this action.');
    const input = VerificationInput.parse(req.body);
    const values = Object.fromEntries(
      Object.entries(input).map(([k, v]) => [COLUMNS[k as keyof typeof COLUMNS], v]),
    );
    const verification = await withContext(db, contextOf(req, 'Save verification'), async (tx) => {
      const v = await loadVersion(tx, req.params.id);
      await assertPeriodWritable(tx, v.id);
      await tx
        .insertInto('verification')
        .values({ tenant_id: v.tenant_id, client_id: v.client_id, installation_id: v.installation_id, period_version_id: v.id, ...values } as never)
        .onConflict((oc) => oc.column('period_version_id').doUpdateSet(values as never))
        .execute()
        .catch((e: { code?: string; constraint?: string }) => {
          if (e.code === '23503' && e.constraint?.includes('country_code')) {
            throw new AppError(400, 'validation_failed', 'Choose a country from the list.');
          }
          if (e.code === '23503' && e.constraint?.includes('member_state')) {
            throw new AppError(400, 'validation_failed', 'Choose a country from the list.');
          }
          throw e;
        });
      return detail(tx, v.id);
    });
    res.json({ verification });
  });

  // Approve or withdraw an approval ("approval by consultant and client", spec 4.10).
  router.post('/period-versions/:id/verification/approvals', async (req, res) => {
    const body = VerificationApproval.parse(req.body);
    const role = req.auth!.user.role;
    const allowed = body.kind === 'consultant' ? can(role, 'verification.approveConsultant') : can(role, 'verification.approveClient');
    if (!allowed) {
      throw new AppError(
        403,
        'forbidden',
        body.kind === 'consultant' ? 'Only a consultant can give the consultant approval.' : 'Only a client user can give the client approval.',
      );
    }
    const action = `${body.approved ? 'Approve' : 'Withdraw approval of'} verification (${body.kind})`;
    const verification = await withContext(db, contextOf(req, action), async (tx) => {
      const v = await loadVersion(tx, req.params.id);
      await assertPeriodWritable(tx, v.id);
      const column = body.kind === 'consultant' ? 'consultant_approved_at' : 'client_approved_at';
      const updated = await tx
        .updateTable('verification')
        .set({ [column]: body.approved ? new Date() : null })
        .where('period_version_id', '=', v.id)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        throw new AppError(409, 'no_verification', 'Enter the verification details before approving them.');
      }
      return detail(tx, v.id);
    });
    res.json({ verification });
  });

  return router;
}

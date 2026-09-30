import type { PeriodCopier } from '../m03-periods';

/**
 * M3-R5 hook: evidence attached to the period itself carries over to version n+1, so the new
 * version starts with the same supporting documents. Evidence on records inside the period
 * (processes, source streams…) moves with those records when their modules copy them.
 * Verification does not carry over: a new version needs its own opinion.
 */
export const copyPeriodEvidence: PeriodCopier = async (tx, from, to) => {
  // Deleted evidence does not carry over (review M13 F1): its old links stay as history.
  const links = await tx
    .selectFrom('evidence_link as l')
    .innerJoin('evidence_document as d', 'd.id', 'l.evidence_id')
    .select(['l.tenant_id', 'l.client_id', 'l.evidence_id'])
    .where('l.record_table', '=', 'period_version')
    .where('l.record_id', '=', from.periodVersionId)
    .where('d.deleted_at', 'is', null)
    .execute();
  if (links.length === 0) return;
  await tx
    .insertInto('evidence_link')
    .values(links.map((l) => ({ ...l, record_table: 'period_version', record_id: to.periodVersionId })) as never)
    .execute();
};

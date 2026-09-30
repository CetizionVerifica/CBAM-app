import { type AffectedRecord, Decimal, type ProcessDetail } from '@cbam/shared';
import type { Tx } from '../../platform/db';
import { AppError } from '../../platform/errors';

/**
 * Records of later modules that hang off a process (M6 source streams, M7 energy flows, M8
 * precursors, M9 carbon prices). Each module registers one, so deleting a process lists them
 * and removes them only after confirmation (M5-R6, D22).
 */
export interface ProcessDependents {
  list(tx: Tx, processId: string): Promise<AffectedRecord[]>;
  remove(tx: Tx, processId: string): Promise<void>;
}

const fmt = (v: string) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(new Decimal(v).toString() as unknown as number);
const amount = (a: { value: string; unit: string }) => `${fmt(a.value)} ${a.unit}`;

/** 409 until the client repeats the request with confirmation (D22). */
export function requireConfirmation(affected: AffectedRecord[], confirm: boolean, what: string): void {
  if (affected.length === 0 || confirm) return;
  throw new AppError(
    409,
    'confirm_required',
    `${what} ${affected.length === 1 ? 'changes 1 record' : `changes ${affected.length} records`} that already hold data. Check the list and confirm.`,
    { affected },
  );
}

export const routeAffected = (p: ProcessDetail, routeIds: Set<string>): AffectedRecord[] =>
  p.routes
    .filter((r) => routeIds.has(r.id) && r.amount)
    .map((r) => ({ table: 'process_route', id: r.id, label: `Production${r.routeName ? ` by ${r.routeName}` : ''}: ${amount(r.amount!)}` }));

/** A good with data, or any good when `always` (a category change drops them all). */
export const goodAffected = (g: ProcessDetail['goods'][number], evidence: AffectedRecord[] = [], always = false): AffectedRecord[] => {
  const data = [g.produced, g.soldEu, g.soldOther].some(Boolean) || g.parameters.length > 0;
  return [
    ...(data || always
      ? [
          {
            table: 'process_good',
            id: g.id,
            label: `Good ${g.cnCode}${g.productName ? ` (${g.productName})` : ''}${g.produced ? `: ${amount(g.produced)} produced` : ''}${
              g.parameters.length ? `, ${g.parameters.length} qualifying parameter${g.parameters.length === 1 ? '' : 's'}` : ''
            }`,
          },
        ]
      : []),
    ...evidence,
  ];
};

/** Evidence linked to these records (M13); the links go with the records. */
export async function evidenceAffected(tx: Tx, records: { table: 'production_process' | 'process_good'; id: string }[]): Promise<AffectedRecord[]> {
  if (records.length === 0) return [];
  const rows = await tx
    .selectFrom('evidence_link as l')
    .innerJoin('evidence_document as d', 'd.id', 'l.evidence_id')
    .select(['l.id', 'd.title'])
    .where((eb) => eb.or(records.map((r) => eb.and([eb('l.record_table', '=', r.table), eb('l.record_id', '=', r.id)]))))
    .execute();
  return rows.map((r) => ({ table: 'evidence_link', id: r.id, label: `Evidence link: ${r.title}` }));
}

export async function removeEvidenceLinks(tx: Tx, records: { table: 'production_process' | 'process_good'; id: string }[]) {
  if (records.length === 0) return;
  await tx
    .deleteFrom('evidence_link')
    .where((eb) => eb.or(records.map((r) => eb.and([eb('record_table', '=', r.table), eb('record_id', '=', r.id)]))))
    .execute();
}

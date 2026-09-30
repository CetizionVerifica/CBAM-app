import { type EvidenceRecordType, periodLabel } from '@cbam/shared';
import type { Tx } from '../../platform/db';

/**
 * Human labels for linked records, read under the caller's RLS: a record they cannot see
 * gets no label. One query per record type, whatever the number of links.
 */
export async function recordLabels(tx: Tx, refs: { recordType: EvidenceRecordType; recordId: string }[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const ids = (type: EvidenceRecordType) => [...new Set(refs.filter((r) => r.recordType === type).map((r) => r.recordId))];
  const key = (type: EvidenceRecordType, id: string) => `${type}:${id}`;

  const clients = ids('client');
  if (clients.length) {
    for (const r of await tx.selectFrom('client').select(['id', 'legal_name']).where('id', 'in', clients).execute()) {
      labels.set(key('client', r.id), `Client: ${r.legal_name}`);
    }
  }
  const installations = ids('installation');
  if (installations.length) {
    for (const r of await tx.selectFrom('installation').select(['id', 'name_en']).where('id', 'in', installations).execute()) {
      labels.set(key('installation', r.id), `Installation: ${r.name_en}`);
    }
  }
  const importers = ids('eu_importer');
  if (importers.length) {
    for (const r of await tx.selectFrom('eu_importer').select(['id', 'name', 'eori']).where('id', 'in', importers).execute()) {
      labels.set(key('eu_importer', r.id), `EU importer: ${r.name} (${r.eori})`);
    }
  }
  const overrides = ids('client_factor_override');
  if (overrides.length) {
    for (const r of await tx.selectFrom('client_factor_override').select(['id', 'kind', 'subject']).where('id', 'in', overrides).execute()) {
      labels.set(key('client_factor_override', r.id), `Factor override: ${r.subject} (${r.kind.replace('_', ' ')})`);
    }
  }
  const processes = ids('production_process');
  if (processes.length) {
    for (const r of await tx.selectFrom('production_process').select(['id', 'name']).where('id', 'in', processes).execute()) {
      labels.set(key('production_process', r.id), `Process: ${r.name}`);
    }
  }
  const goods = ids('process_good');
  if (goods.length) {
    const rows = await tx
      .selectFrom('process_good as g')
      .innerJoin('production_process as p', 'p.id', 'g.process_id')
      .select(['g.id', 'g.cn_code', 'g.product_name', 'p.name'])
      .where('g.id', 'in', goods)
      .execute();
    for (const r of rows) labels.set(key('process_good', r.id), `Good: ${r.cn_code}${r.product_name ? ` ${r.product_name}` : ''} (${r.name})`);
  }
  const versions = ids('period_version');
  const verifications = ids('verification');
  if (versions.length || verifications.length) {
    const periodRows = (column: 'v.id' | 'f.id', wanted: string[]) =>
      tx
        .selectFrom('period_version as v')
        .innerJoin('reporting_period as p', 'p.id', 'v.period_id')
        .innerJoin('installation as i', 'i.id', 'v.installation_id')
        .leftJoin('verification as f', 'f.period_version_id', 'v.id')
        .select(['v.id as version_id', 'f.id as verification_id', 'v.version_no', 'p.start_date', 'p.end_date', 'i.name_en'])
        .where(column, 'in', wanted)
        .execute();
    const period = (r: { start_date: string; end_date: string; version_no: number; name_en: string }) =>
      `${r.name_en} ${periodLabel(r.start_date, r.end_date)}, version ${r.version_no}`;
    if (versions.length) {
      for (const r of await periodRows('v.id', versions)) labels.set(key('period_version', r.version_id), `Reporting period: ${period(r)}`);
    }
    if (verifications.length) {
      for (const r of await periodRows('f.id', verifications)) labels.set(key('verification', r.verification_id!), `Verification: ${period(r)}`);
    }
  }
  return labels;
}

export const labelKey = (type: EvidenceRecordType, id: string) => `${type}:${id}`;

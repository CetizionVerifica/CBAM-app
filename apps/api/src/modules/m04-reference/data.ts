import { createHash } from 'node:crypto';
import {
  type CnCodeEntry,
  type CnCodeRow,
  Decimal,
  type DiffDataset,
  FACTOR_KIND_LABELS,
  type FactorKind,
  type GoodsCategoryEntry,
  type LibraryDiff,
  type LibraryFactor,
  type SeeComponent,
  factorKey,
} from '@cbam/shared';
import type { Selectable } from 'kysely';
import type { LibraryFactor as FactorTable } from '../../db-types';
import type { Tx } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { type DiffRecord, diffRecords, isEmptyDiff } from './diff';
import type { FactorRow } from './import';

type FactorDbRow = Selectable<FactorTable>;

const dec = (v: string | null) => (v == null ? null : new Decimal(v).toString());

// --- DTOs -------------------------------------------------------------------

export const factorDto = (r: FactorDbRow): LibraryFactor => ({
  id: r.id,
  kind: r.kind as FactorKind,
  subject: r.subject,
  countryCode: r.country_code?.trimEnd() ?? null,
  region: r.region,
  year: r.year,
  component: r.component as SeeComponent | null,
  value: dec(r.value)!,
  unit: r.unit,
  valueSi: dec(r.value_si)!,
  siUnit: r.si_unit,
  plausibleMin: dec(r.plausible_min),
  plausibleMax: dec(r.plausible_max),
  validFrom: r.valid_from,
  validTo: r.valid_to,
  source: r.source,
  notes: r.notes,
});

/** Validated factor → table columns (both the value as entered and in SI, G5). */
export const factorColumns = (f: FactorRow) => ({
  kind: f.kind,
  subject: f.subject,
  country_code: f.countryCode ?? null,
  region: f.region ?? null,
  year: f.year ?? null,
  component: f.component ?? null,
  value: f.value,
  unit: f.unit,
  value_si: f.valueSi,
  si_unit: f.siUnit,
  plausible_min: f.plausibleMin ?? null,
  plausible_max: f.plausibleMax ?? null,
  valid_from: f.validFrom,
  valid_to: f.validTo ?? null,
  source: f.source,
  notes: f.notes ?? null,
});

// --- loaders ----------------------------------------------------------------

export const notFound = (what: string) => new AppError(404, 'not_found', `This ${what} does not exist.`);

export async function loadVersion(tx: Tx, id: string) {
  const v = await tx.selectFrom('library_version').selectAll().where('id', '=', id).executeTakeFirst();
  if (!v) throw notFound('library version');
  return v;
}

/** API-side lock check (G2); the database trigger is the backstop (M4-R2). */
export async function loadDraft(tx: Tx, id: string) {
  const v = await loadVersion(tx, id);
  if (v.status !== 'draft') {
    throw new AppError(409, 'library_published', `Library version ${v.code} is published and cannot be changed. Create a new draft version.`);
  }
  return v;
}

/** The version new periods pin (M4-R3): the most recently published one. */
export async function currentVersion(tx: Tx) {
  return tx
    .selectFrom('library_version')
    .selectAll()
    .where('status', '=', 'published')
    .orderBy('published_at', 'desc')
    .limit(1)
    .executeTakeFirst();
}

export async function loadFactors(tx: Tx, versionId: string) {
  return tx
    .selectFrom('library_factor')
    .selectAll()
    .where('library_version_id', '=', versionId)
    .orderBy('kind')
    .orderBy('subject')
    .orderBy('country_code')
    .orderBy('year')
    .orderBy('component')
    .execute();
}

export async function loadCnCodes(tx: Tx, versionId: string): Promise<CnCodeEntry[]> {
  const rows = await tx
    .selectFrom('cn_code')
    .select(['code', 'description', 'goods_category_code'])
    .where('library_version_id', '=', versionId)
    .orderBy('code')
    .execute();
  return rows.map((r) => ({ code: r.code, description: r.description, goodsCategoryCode: r.goods_category_code }));
}

export async function loadGoods(tx: Tx, versionId: string): Promise<GoodsCategoryEntry[]> {
  const [cats, routes, precursors, params] = await Promise.all([
    tx.selectFrom('goods_category').selectAll().where('library_version_id', '=', versionId).orderBy('sort_order').execute(),
    tx.selectFrom('production_route').selectAll().where('library_version_id', '=', versionId).orderBy('sort_order').execute(),
    tx
      .selectFrom('route_relevant_precursor')
      .selectAll()
      .where('library_version_id', '=', versionId)
      .orderBy('precursor_category_code')
      .execute(),
    tx.selectFrom('qualifying_parameter_def').selectAll().where('library_version_id', '=', versionId).orderBy('position').execute(),
  ]);
  return cats.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    templateName: c.template_name,
    sector: c.sector,
    unit: c.unit,
    indirectRelevantDefinitive: c.indirect_relevant_definitive,
    indirectRelevantTransitional: c.indirect_relevant_transitional,
    routeRelevant: c.route_relevant,
    routes: routes.filter((r) => r.goods_category_code === c.code).map((r) => ({ code: r.code, name: r.name })),
    precursors: precursors
      .filter((p) => p.goods_category_code === c.code)
      .map((p) => ({ routeCode: p.route_code, precursorCode: p.precursor_category_code })),
    qualifyingParameters: params
      .filter((p) => p.goods_category_code === c.code)
      .map((p) => ({ position: p.position, name: p.name })),
  }));
}

// --- diff records ---------------------------------------------------------------

export function factorLabel(f: Pick<LibraryFactor, 'kind' | 'subject' | 'countryCode' | 'region' | 'year' | 'component'>) {
  const parts = [f.subject, f.countryCode, f.region, f.year, f.component].filter((p) => p != null && p !== '');
  return `${FACTOR_KIND_LABELS[f.kind]}: ${parts.join(', ')}`;
}

export const factorRecord = (f: LibraryFactor): DiffRecord => ({
  key: factorKey(f),
  label: factorLabel(f),
  fields: {
    value: f.value,
    unit: f.unit,
    validFrom: f.validFrom,
    validTo: f.validTo,
    plausibleMin: f.plausibleMin,
    plausibleMax: f.plausibleMax,
    source: f.source,
    notes: f.notes,
  },
});

export const factorRowRecord = (f: FactorRow): DiffRecord =>
  factorRecord({
    ...f,
    id: '',
    countryCode: f.countryCode ?? null,
    region: f.region ?? null,
    year: f.year ?? null,
    component: f.component ?? null,
    value: new Decimal(f.value).toString(),
    plausibleMin: dec(f.plausibleMin ?? null),
    plausibleMax: dec(f.plausibleMax ?? null),
    validTo: f.validTo ?? null,
    notes: f.notes ?? null,
  });

export const cnRecord = (c: CnCodeEntry | CnCodeRow): DiffRecord => ({
  key: c.code,
  label: `${c.code} ${c.description}`.slice(0, 160),
  fields: { description: c.description, goodsCategory: c.goodsCategoryCode },
});

async function recordsOf(tx: Tx, versionId: string, dataset: DiffDataset): Promise<DiffRecord[]> {
  switch (dataset) {
    case 'factors':
      return (await loadFactors(tx, versionId)).map((r) => factorRecord(factorDto(r)));
    case 'cn_codes':
      return (await loadCnCodes(tx, versionId)).map(cnRecord);
    default: {
      const goods = await loadGoods(tx, versionId);
      if (dataset === 'goods_categories') {
        return goods.map((g) => ({
          key: g.code,
          label: g.name,
          fields: {
            name: g.name,
            unit: g.unit,
            sector: g.sector,
            indirectRelevantDefinitive: g.indirectRelevantDefinitive,
            indirectRelevantTransitional: g.indirectRelevantTransitional,
            routeRelevant: g.routeRelevant,
          },
        }));
      }
      if (dataset === 'routes') {
        return goods.flatMap((g) => g.routes.map((r) => ({ key: `${g.code}|${r.code}`, label: `${g.name}: ${r.name}`, fields: { name: r.name } })));
      }
      if (dataset === 'precursors') {
        const name = new Map(goods.map((g) => [g.code, g.name]));
        return goods.flatMap((g) =>
          g.precursors.map((p) => ({
            key: `${g.code}|${p.routeCode ?? ''}|${p.precursorCode}`,
            label: `${g.name}${p.routeCode ? ` (${p.routeCode})` : ''} ← ${name.get(p.precursorCode) ?? p.precursorCode}`,
            fields: {},
          })),
        );
      }
      return goods.flatMap((g) =>
        g.qualifyingParameters.map((q) => ({ key: `${g.code}|${q.position}`, label: `${g.name}: ${q.name}`, fields: { name: q.name } })),
      );
    }
  }
}

/** Every dataset that differs between two versions (publish preview, M4-R4 / design system 6.12). */
export async function diffVersions(tx: Tx, fromId: string | null, toId: string): Promise<LibraryDiff> {
  const out: LibraryDiff = {};
  for (const ds of ['factors', 'cn_codes', 'goods_categories', 'routes', 'precursors', 'qualifying_parameters'] as const) {
    const before = fromId ? await recordsOf(tx, fromId, ds) : [];
    const d = diffRecords(before, await recordsOf(tx, toId, ds));
    if (!isEmptyDiff(d)) out[ds] = d;
  }
  return out;
}

/** Records of one import dataset in a version, and their fingerprint (stale-preview check). */
export async function datasetState(tx: Tx, versionId: string, dataset: 'factors' | 'cn_codes') {
  const records = await recordsOf(tx, versionId, dataset);
  const fingerprint = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  return { records, fingerprint };
}

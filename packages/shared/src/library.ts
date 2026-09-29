import { z } from 'zod';
import { Decimal, DecimalString } from './decimal';
import { optionalText, requiredText } from './fields';
import { CountryCode } from './registry';
import { type Dimension, type UnitId, UNITS, isUnitId, unitsFor } from './units';

/**
 * M4 — reference library. Shared by API, import and forms (G7). Factors of every kind share
 * one shape (decision D7); `factorRules` holds the per-kind rules.
 */

export const FACTOR_KINDS = ['emission_factor', 'ncv', 'gwp', 'grid_factor', 'default_see'] as const;
export const FactorKind = z.enum(FACTOR_KINDS);
export type FactorKind = z.infer<typeof FactorKind>;

export const FACTOR_KIND_LABELS: Record<FactorKind, string> = {
  emission_factor: 'Emission factor',
  ncv: 'Net calorific value',
  gwp: 'Global warming potential',
  grid_factor: 'Grid emission factor',
  default_see: 'Default value',
};

/** Units allowed per kind, by dimension. */
export const FACTOR_KIND_DIMENSIONS: Record<FactorKind, readonly Dimension[]> = {
  emission_factor: ['ef_energy', 'ef_mass', 'ef_volume'],
  ncv: ['ncv_mass', 'ncv_volume'],
  gwp: ['gwp'],
  grid_factor: ['ef_electricity'],
  default_see: ['see', 'see_electricity'],
};

export const unitsForKind = (kind: FactorKind): UnitId[] => FACTOR_KIND_DIMENSIONS[kind].flatMap((d) => unitsFor(d));

export const SEE_COMPONENTS = ['direct', 'indirect'] as const;
export const SeeComponent = z.enum(SEE_COMPONENTS);
export type SeeComponent = z.infer<typeof SeeComponent>;

export const LIBRARY_VERSION_STATUSES = ['draft', 'published'] as const;
export type LibraryVersionStatus = (typeof LIBRARY_VERSION_STATUSES)[number];

export const OVERRIDE_STATUSES = ['proposed', 'approved', 'rejected', 'withdrawn'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/** Business date, 'YYYY-MM-DD', a real calendar day. */
export const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a real date.');

// A string test, not `new Decimal(v)`: Zod runs refinements even after the regex fails.
const NonNegativeDecimal = DecimalString.refine((v) => !v.startsWith('-') || /^-0+(\.0+)?$/.test(v), 'Enter zero or a positive number.');

const optionalDecimal = z
  .union([z.literal(''), NonNegativeDecimal])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const optionalDate = z
  .union([z.literal(''), IsoDate])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

export const LibraryYear = z
  .number({ error: 'Enter a year, like 2026.' })
  .int('Enter a year, like 2026.')
  .min(1990, 'Enter a year from 1990 to 2100.')
  .max(2100, 'Enter a year from 1990 to 2100.');

export const CnCode = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{8}$/, 'Enter an 8-digit CN code, like 72081000.'));

/** The key that identifies a factor within a version (and an override within a client). */
const FactorKeyFields = {
  kind: FactorKind,
  subject: requiredText(200, 'Enter what the factor applies to: a fuel, material, gas or CN code.'),
  countryCode: CountryCode.nullable().optional(),
  region: optionalText(100),
  year: LibraryYear.nullable().optional(),
  component: SeeComponent.nullable().optional(),
};

const FactorValueFields = {
  value: NonNegativeDecimal,
  unit: z.string().trim().min(1, 'Choose a unit.'),
  validFrom: IsoDate,
  validTo: optionalDate,
  source: requiredText(500, 'Enter the source or legal reference.'),
};

export const FactorFields = z.object({
  ...FactorKeyFields,
  ...FactorValueFields,
  plausibleMin: optionalDecimal,
  plausibleMax: optionalDecimal,
  notes: optionalText(1000),
});

interface KeyShape {
  kind: FactorKind;
  subject: string;
  countryCode?: string | null;
  region?: string | null;
  year?: number | null;
  component?: SeeComponent | null;
  unit: string;
  validFrom: string;
  validTo?: string | null;
  plausibleMin?: string | null;
  plausibleMax?: string | null;
}

/** Per-kind rules (M4-R1, R6). Messages name the field the way the form labels it. */
export function checkFactor(v: KeyShape, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  const allowed = unitsForKind(v.kind);
  if (!isUnitId(v.unit) || !allowed.includes(v.unit)) {
    issue('unit', `Use one of these units for this kind (${FACTOR_KIND_LABELS[v.kind].toLowerCase()}): ${allowed.map((u) => UNITS[u].label).join(', ')}.`);
  }
  if (v.kind === 'grid_factor') {
    if (!v.countryCode) issue('countryCode', 'A grid emission factor needs a country.');
    if (v.year == null) issue('year', 'A grid emission factor needs a year.');
  } else if (v.region) {
    issue('region', 'Only grid emission factors have a region.');
  }
  if (v.kind === 'default_see') {
    if (!v.component) issue('component', 'Choose direct or indirect.');
    if (!/^\d{8}$/.test(v.subject)) issue('subject', 'A default value applies to an 8-digit CN code, like 72081000.');
  } else if (v.component) {
    issue('component', 'Only default values are split into direct and indirect.');
  }
  if (v.validTo && v.validTo < v.validFrom) issue('validTo', 'The end date must be on or after the start date.');
  const num = /^-?\d+(\.\d+)?$/;
  if (v.plausibleMin && v.plausibleMax && num.test(v.plausibleMin) && num.test(v.plausibleMax) && new Decimal(v.plausibleMin).gt(v.plausibleMax)) {
    issue('plausibleMax', 'The upper bound must be at least the lower bound.');
  }
}

export const FactorInput = FactorFields.superRefine(checkFactor);
export type FactorInput = z.infer<typeof FactorInput>;
export const FactorPatch = FactorFields.omit({ kind: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.');
export type FactorPatch = z.infer<typeof FactorPatch>;

/** Identity of a factor within a version; also the diff key. */
export function factorKey(f: {
  kind: string;
  subject: string;
  countryCode?: string | null;
  region?: string | null;
  year?: number | null;
  component?: string | null;
}): string {
  return [f.kind, f.subject, f.countryCode ?? '', f.region ?? '', f.year ?? '', f.component ?? ''].join('|');
}

// ---------------------------------------------------------------------------
// Versions, regulatory configuration, imports
// ---------------------------------------------------------------------------

export const LibraryVersionCode = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/, 'Use letters, digits, dots or dashes, like 2026.2.');

export const CreateLibraryVersionRequest = z.object({
  code: LibraryVersionCode,
  notes: optionalText(2000),
});

export const GoodsCategoryPatch = z
  .object({
    indirectRelevantDefinitive: z.boolean().optional(),
    indirectRelevantTransitional: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.');

export const RelevantPrecursorsRequest = z.object({
  precursors: z
    .array(z.object({ routeCode: z.string().trim().min(1).nullable(), precursorCode: z.string().trim().min(1) }))
    .max(50),
});

export const IMPORT_DATASETS = ['factors', 'cn_codes'] as const;
export const ImportDataset = z.enum(IMPORT_DATASETS);
export type ImportDataset = z.infer<typeof ImportDataset>;

export const IMPORT_MAX_ROWS = 20_000;
export const IMPORT_MAX_CHARS = 8_000_000;

export const ImportRequest = z.object({
  dataset: ImportDataset,
  fileName: z.string().trim().min(1).max(255).regex(/\.csv$/i, 'Upload a .csv file.'),
  content: z.string().min(1, 'The file is empty.').max(IMPORT_MAX_CHARS, 'The file is larger than 8 MB.'),
});

/**
 * CSV layouts (docs/mappings/library-import.md). Headers are matched case-insensitively;
 * column order does not matter; extra columns are an error so a wrong file is not half-read.
 */
export const IMPORT_COLUMNS: Record<ImportDataset, { required: readonly string[]; optional: readonly string[] }> = {
  factors: {
    required: ['kind', 'subject', 'value', 'unit', 'valid_from', 'source'],
    optional: ['country_code', 'region', 'year', 'component', 'valid_to', 'plausible_min', 'plausible_max', 'notes'],
  },
  cn_codes: {
    required: ['cn_code', 'description', 'goods_category'],
    optional: [],
  },
};

export const CnCodeRow = z.object({
  code: CnCode,
  description: requiredText(1000, 'Enter the CN code description.'),
  goodsCategoryCode: z.string().trim().min(1, 'Enter the goods category code, like crude_steel.'),
});
export type CnCodeRow = z.infer<typeof CnCodeRow>;

export const PublishRequest = z.object({
  /** The version code typed back, to confirm a wide-impact action (design system 7). */
  confirmCode: z.string().trim().min(1, 'Type the version code to confirm.'),
  /** From GET …/diff: publishing is refused if the draft changed after the diff was shown. */
  diffFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

// ---------------------------------------------------------------------------
// Client-specific overrides (M4-R5)
// ---------------------------------------------------------------------------

export const OverrideFields = z.object({
  ...FactorKeyFields,
  ...FactorValueFields,
  justification: requiredText(1000, 'Say why this client needs its own value.'),
});
export const OverrideInput = OverrideFields.superRefine(checkFactor);
export type OverrideInput = z.infer<typeof OverrideInput>;

export const OverrideDecision = z.object({ note: optionalText(1000) });
export const OverrideRejection = z.object({
  note: requiredText(1000, 'Say why the override is rejected.'),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface LibraryVersionSummary {
  id: string;
  code: string;
  status: LibraryVersionStatus;
  basedOnCode: string | null;
  notes: string | null;
  publishedAt: string | null;
  /** The version new periods pin: the latest published one. */
  isCurrent: boolean;
  createdAt: string;
  counts: { factors: number; cnCodes: number; goodsCategories: number };
}

export interface LibraryFactor {
  id: string;
  kind: FactorKind;
  subject: string;
  countryCode: string | null;
  region: string | null;
  year: number | null;
  component: SeeComponent | null;
  value: string;
  unit: string;
  valueSi: string;
  siUnit: string;
  plausibleMin: string | null;
  plausibleMax: string | null;
  validFrom: string;
  validTo: string | null;
  source: string;
  notes: string | null;
}

export interface CnCodeEntry {
  code: string;
  description: string;
  goodsCategoryCode: string;
}

export interface GoodsCategoryEntry {
  id: string;
  code: string;
  name: string;
  templateName: string;
  sector: string;
  unit: string;
  indirectRelevantDefinitive: boolean;
  indirectRelevantTransitional: boolean;
  routeRelevant: boolean;
  routes: { code: string; name: string }[];
  precursors: { routeCode: string | null; precursorCode: string }[];
  qualifyingParameters: { position: number; name: string }[];
}

export interface TemplateVersionEntry {
  code: string;
  title: string;
  fileName: string;
  fileSha256: string;
  releasedOn: string;
}

export interface DiffRow {
  key: string;
  label: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** For changed rows: the fields that differ. */
  fields?: string[];
}

export interface DatasetDiff {
  added: DiffRow[];
  changed: DiffRow[];
  removed: DiffRow[];
}

export const DIFF_DATASETS = ['factors', 'cn_codes', 'goods_categories', 'routes', 'precursors', 'qualifying_parameters'] as const;
export type DiffDataset = (typeof DIFF_DATASETS)[number];
export type LibraryDiff = Partial<Record<DiffDataset, DatasetDiff>>;

export interface ImportRowError {
  /** 1-based line number in the file, counting the header as line 1. */
  row: number;
  column?: string;
  message: string;
}

export interface ImportPreview {
  id: string;
  dataset: ImportDataset;
  fileName: string;
  rowCount: number;
  diff: DatasetDiff;
}

export interface FactorOverride {
  id: string;
  clientId: string;
  kind: FactorKind;
  subject: string;
  countryCode: string | null;
  region: string | null;
  year: number | null;
  component: SeeComponent | null;
  value: string;
  unit: string;
  valueSi: string;
  siUnit: string;
  validFrom: string;
  validTo: string | null;
  source: string;
  justification: string;
  status: OverrideStatus;
  proposedBy: string;
  proposedByName: string | null;
  proposedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** The value in the current library for the same key, if any, for comparison. */
  libraryValue: { value: string; unit: string; versionCode: string } | null;
}

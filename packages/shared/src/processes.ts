import { z } from 'zod';
import { Decimal } from './decimal';
import type { Provenance } from './enums';
import { optionalText } from './fields';
import { QUALIFYING_DIMENSIONS, type QualifyingParameterDef } from './library';
import { type QuantityInput, quantityInput } from './quantity';
import type { Dimension } from './units';

/**
 * M5 — process and goods set-up (docs/plans/phase-2.md, D16–D23). A process has a main goods
 * category, included precursor categories, production per route (the activity level), goods
 * (CN codes) with qualifying parameters, and the quantities consumed inside the installation.
 */

// ---------------------------------------------------------------------------
// Limits from the official template (D16)
// ---------------------------------------------------------------------------

/** P1–P10 in A_InstData (b). */
export const MAX_PROCESSES = 10;
/** G1–G10 in A_InstData (a): distinct categories across all processes of a period. */
export const MAX_CATEGORIES = 10;
/** Six "included goods categories" per process: the main one and five more. */
export const MAX_INCLUDED_CATEGORIES = 5;

export const PROCESS_STATUSES = ['draft', 'complete'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

/** Goods categories are declared per tonne, electricity per MWh (goods_category.unit). */
export const categoryDimension = (unit: string): Dimension => (unit === 'MWh' ? 'electricity' : 'mass');

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const Code = z.string().trim().min(1).max(80);
const RouteCodes = z
  .array(Code)
  .max(8)
  .refine((r) => new Set(r).size === r.length, 'Choose each route once.');

/**
 * A production quantity (G5, G7): amount in t (or MWh for electricity), never negative. The
 * API checks the unit against the category of the process.
 */
export const AmountInput = quantityInput(['mass', 'electricity']).refine((q) => !new Decimal(q.value).isNegative(), {
  message: 'Enter zero or more.',
  path: ['value'],
});
export type AmountInput = QuantityInput;

const ProcessName = z.string().trim().min(1, 'Enter a name for the process.').max(200, 'Use at most 200 characters.');

export const IncludedCategoryInput = z.object({ code: Code, routeCodes: RouteCodes.default([]) });

const IncludedCategories = z
  .array(IncludedCategoryInput)
  .max(MAX_INCLUDED_CATEGORIES, `A process can include at most ${MAX_INCLUDED_CATEGORIES} other goods categories.`)
  .refine((c) => new Set(c.map((x) => x.code)).size === c.length, 'Include each goods category once.');

/** M5-R1: category and routes from the pinned library; the API checks the codes. */
export const CreateProcessRequest = z.object({
  name: ProcessName,
  goodsCategoryCode: Code,
  routeCodes: RouteCodes.default([]),
  includedCategories: IncludedCategories.default([]),
});
export type CreateProcessRequest = z.infer<typeof CreateProcessRequest>;

/**
 * Changes to the set-up. Changing the category, or dropping a route that has production,
 * needs `confirm: true` once the API has listed the affected records (M5-R5, D22).
 */
export const UpdateProcessRequest = z
  .object({
    name: ProcessName.optional(),
    goodsCategoryCode: Code.optional(),
    routeCodes: RouteCodes.optional(),
    includedCategories: IncludedCategories.optional(),
    confirm: z.boolean().default(false),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'confirm'), 'Change at least one field.');
export type UpdateProcessRequest = z.infer<typeof UpdateProcessRequest>;

export const CnCodeInput = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s.]/g, ''))
  .pipe(z.string().regex(/^\d{8}$/, 'Enter the 8-digit CN code.'));

export const GoodInput = z.object({ cnCode: CnCodeInput, productName: optionalText(200) });
export type GoodInput = z.infer<typeof GoodInput>;

export const GoodPatch = z
  .object({ cnCode: CnCodeInput.optional(), productName: optionalText(200) })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.');
export type GoodPatch = z.infer<typeof GoodPatch>;

/** D_Processes (a), (c), (d): production per route, consumption by other processes, non-CBAM. */
export const ProductionRequest = z.object({
  routes: z.array(z.object({ routeId: z.uuid(), amount: AmountInput.nullable() })).max(8),
  nonCbam: AmountInput.nullable(),
  internalUses: z
    .array(z.object({ consumerProcessId: z.uuid(), amount: AmountInput.nullable() }))
    .max(MAX_PROCESSES - 1)
    .refine((u) => new Set(u.map((x) => x.consumerProcessId)).size === u.length, 'List each consuming process once.'),
});
export type ProductionRequest = z.infer<typeof ProductionRequest>;

/** A qualifying parameter value: text (or a choice) or a number with its quantity group. */
export const ParameterValueInput = z
  .object({
    position: z.number().int().min(1).max(8),
    text: z.string().trim().min(1).max(200).nullable().default(null),
    quantity: quantityInput(QUALIFYING_DIMENSIONS).nullable().default(null),
  })
  .refine((v) => v.text === null || v.quantity === null, 'Give text or a number, not both.');
export type ParameterValueInput = z.infer<typeof ParameterValueInput>;

/** Quantities of a good and its qualifying parameters (spec 4.3). */
export const GoodDataRequest = z.object({
  produced: AmountInput.nullable(),
  soldEu: AmountInput.nullable(),
  soldOther: AmountInput.nullable(),
  parameters: z
    .array(ParameterValueInput)
    .max(8)
    .refine((p) => new Set(p.map((x) => x.position)).size === p.length, 'Give each parameter once.'),
});
export type GoodDataRequest = z.infer<typeof GoodDataRequest>;

/** `?confirm=true` on deletes (M5-R6). */
export const ConfirmQuery = z.object({ confirm: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface StoredAmount {
  value: string;
  unit: string;
  si: string;
  source: string;
  provenance: Provenance;
  defaultRef: string | null;
}

export interface ProcessRouteRow {
  id: string;
  /** Null when the category has no routes. */
  routeCode: string | null;
  routeName: string | null;
  amount: StoredAmount | null;
}

export interface IncludedCategory {
  code: string;
  name: string;
  routeCodes: string[];
}

export interface ParameterValue {
  position: number;
  text: string | null;
  quantity: StoredAmount | null;
}

export interface ProcessGood {
  id: string;
  cnCode: string;
  cnDescription: string;
  productName: string | null;
  produced: StoredAmount | null;
  soldEu: StoredAmount | null;
  soldOther: StoredAmount | null;
  parameters: ParameterValue[];
}

export interface InternalUse {
  id: string;
  consumerProcessId: string;
  consumerName: string;
  amount: StoredAmount | null;
}

export type CheckSeverity = 'critical' | 'warning';

/** A check result (D20). M11 will persist these as issues with the same rule IDs (M11-R6). */
export interface ProcessCheck {
  ruleId: ProcessRuleId;
  severity: CheckSeverity;
  message: string;
  processId: string;
  record: { type: 'production_process' | 'process_route' | 'process_good' | 'process_internal_use'; id: string };
}

/** Template control row D_Processes (e), in the base unit of the category (t or MWh). */
export interface ProductionBalance {
  activityLevel: string | null;
  goods: string;
  internalUse: string;
  nonCbam: string;
  /** Activity level − goods − internal use − non-CBAM; null until every amount is entered. */
  difference: string | null;
  /** Fraction of the activity level, from the pinned library (D19). */
  tolerance: string;
  withinTolerance: boolean | null;
}

export interface ProcessSummary {
  id: string;
  position: number;
  name: string;
  goodsCategory: { code: string; name: string; unit: string };
  status: ProcessStatus;
  /** Σ production per route in the category's base unit; null while any route is empty. */
  activityLevel: string | null;
  goodsCount: number;
  openChecks: { critical: number; warning: number };
}

export interface ProcessDetail extends ProcessSummary {
  periodVersionId: string;
  installationId: string;
  clientId: string;
  libraryVersionId: string;
  routeRelevant: boolean;
  routes: ProcessRouteRow[];
  includedCategories: IncludedCategory[];
  goods: ProcessGood[];
  qualifyingParameters: QualifyingParameterDef[];
  internalUses: InternalUse[];
  nonCbam: StoredAmount | null;
  balance: ProductionBalance;
  checks: ProcessCheck[];
  completedAt: string | null;
  completedBy: string | null;
  /** Other processes of the period, for the internal-use table. */
  otherProcesses: { id: string; name: string }[];
}

export interface ProcessList {
  periodVersionId: string;
  libraryVersion: { id: string; code: string };
  /** True for approved and issued versions: nothing can change (G4). */
  locked: boolean;
  processes: ProcessSummary[];
  checks: ProcessCheck[];
}

/** A record the change would delete or invalidate (M5-R5, R6). */
export interface AffectedRecord {
  table: string;
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Checks (D20). Pure: the API computes them; the UI shows what the API returns.
// ---------------------------------------------------------------------------

export const PROCESS_RULES = {
  'M5-C01': 'Production per route entered',
  'M5-C02': 'At least one good',
  'M5-C03': 'Quantity produced of each good entered',
  'M5-C04': 'Required qualifying parameters entered',
  'M5-C05': 'Production balance within tolerance',
  'M5-C06': 'Amount consumed by each listed process entered',
  'M5-C07': 'Quantities sold do not exceed production',
} as const;
export type ProcessRuleId = keyof typeof PROCESS_RULES;

/** What the checks need to know about one process; amounts are base-unit strings. */
export interface ProcessFacts {
  id: string;
  name: string;
  /** Base unit label of the category: t or MWh. */
  unit: string;
  routes: { id: string; label: string | null; amountSi: string | null }[];
  goods: {
    id: string;
    label: string;
    producedSi: string | null;
    soldEuSi: string | null;
    soldOtherSi: string | null;
    filledPositions: number[];
  }[];
  qualifyingParameters: Pick<QualifyingParameterDef, 'position' | 'name' | 'required'>[];
  internalUses: { id: string; consumerName: string; amountSi: string | null }[];
  nonCbamSi: string | null;
  tolerance: string;
}

const fmt = (v: Decimal) =>
  new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(v.toString() as unknown as number);

const sum = (values: (string | null)[]) => values.reduce((acc, v) => (v === null ? acc : acc.plus(v)), new Decimal(0));

/** The template's control row (e) with the tolerance of M5-R3. */
export function productionBalance(p: ProcessFacts): ProductionBalance {
  const routesComplete = p.routes.length > 0 && p.routes.every((r) => r.amountSi !== null);
  const al = routesComplete ? sum(p.routes.map((r) => r.amountSi)) : null;
  const goods = sum(p.goods.map((g) => g.producedSi));
  const internal = sum(p.internalUses.map((u) => u.amountSi));
  const nonCbam = new Decimal(p.nonCbamSi ?? 0);
  const allEntered = al !== null && p.goods.every((g) => g.producedSi !== null) && p.internalUses.every((u) => u.amountSi !== null);
  const difference = allEntered ? al.minus(goods).minus(internal).minus(nonCbam) : null;
  return {
    activityLevel: al?.toString() ?? null,
    goods: goods.toString(),
    internalUse: internal.toString(),
    nonCbam: nonCbam.toString(),
    difference: difference?.toString() ?? null,
    tolerance: p.tolerance,
    withinTolerance: difference === null ? null : difference.abs().lte(al!.times(p.tolerance)),
  };
}

export function processChecks(p: ProcessFacts): ProcessCheck[] {
  const out: ProcessCheck[] = [];
  const add = (ruleId: ProcessRuleId, severity: CheckSeverity, message: string, record: ProcessCheck['record']) =>
    out.push({ ruleId, severity, message, processId: p.id, record });
  const self = { type: 'production_process' as const, id: p.id };

  if (p.routes.length === 0) add('M5-C01', 'critical', `${p.name}: choose at least one production route.`, self);
  for (const r of p.routes) {
    if (r.amountSi === null) {
      add('M5-C01', 'critical', `${p.name}: enter the production${r.label ? ` by ${r.label}` : ''}.`, { type: 'process_route', id: r.id });
    }
  }
  if (p.goods.length === 0) add('M5-C02', 'critical', `${p.name}: add the CN codes this process makes.`, self);
  const required = p.qualifyingParameters.filter((q) => q.required);
  for (const g of p.goods) {
    const rec = { type: 'process_good' as const, id: g.id };
    if (g.producedSi === null) add('M5-C03', 'critical', `${g.label}: enter the quantity produced.`, rec);
    const missing = required.filter((q) => !g.filledPositions.includes(q.position));
    if (missing.length) {
      add('M5-C04', 'critical', `${g.label}: enter ${missing.map((q) => q.name).join(', ')}.`, rec);
    }
    if (g.producedSi !== null && (g.soldEuSi !== null || g.soldOtherSi !== null)) {
      const sold = sum([g.soldEuSi, g.soldOtherSi]);
      if (sold.gt(g.producedSi)) {
        add('M5-C07', 'warning', `${g.label}: ${fmt(sold)} ${p.unit} sold is more than the ${fmt(new Decimal(g.producedSi))} ${p.unit} produced. Explain it if sales came from stock.`, rec);
      }
    }
  }
  for (const u of p.internalUses) {
    if (u.amountSi === null) {
      add('M5-C06', 'warning', `${p.name}: enter the amount consumed by ${u.consumerName}, or remove it.`, { type: 'process_internal_use', id: u.id });
    }
  }
  const b = productionBalance(p);
  if (b.withinTolerance === false) {
    const al = new Decimal(b.activityLevel!);
    const used = al.minus(b.difference!);
    add(
      'M5-C05',
      'critical',
      `${p.name}: goods, internal use and non-CBAM consumption add up to ${fmt(used)} ${p.unit}, but the activity level is ${fmt(al)} ${p.unit}. ` +
        `The difference of ${fmt(new Decimal(b.difference!))} ${p.unit} is more than the ${fmt(new Decimal(p.tolerance).times(100))} % allowed.`,
      self,
    );
  }
  return out;
}

/** A process can be marked complete only with no critical check open (D20). */
export const canComplete = (checks: ProcessCheck[]) => !checks.some((c) => c.severity === 'critical');

import {
  CnCodeRow,
  FactorInput,
  IMPORT_COLUMNS,
  IMPORT_MAX_ROWS,
  type ImportDataset,
  type ImportRowError,
  UNITS,
  type UnitId,
  baseUnit,
  factorKey,
  toBase,
} from '@cbam/shared';
import type { z } from 'zod';
import { CsvSyntaxError, parseCsv } from './csv';

/** A factor ready to store: the validated input plus its SI value (G5). */
export type FactorRow = FactorInput & { valueSi: string; siUnit: string };

export const withSi = (f: FactorInput): FactorRow => {
  const unit = f.unit as UnitId;
  return { ...f, valueSi: toBase(f.value, unit).toString(), siUnit: baseUnit(UNITS[unit].dimension) };
};

export type ParsedImport =
  | { ok: true; dataset: 'factors'; rows: FactorRow[]; lines: number[] }
  | { ok: true; dataset: 'cn_codes'; rows: CnCodeRow[]; lines: number[] }
  | { ok: false; errors: ImportRowError[] };

const MAX_ERRORS = 200;

/**
 * Parses and validates a whole import file (M4-R4). Any error rejects the whole file (AT2):
 * the caller stores nothing unless `ok` is true. Errors carry the file line number.
 * Checks that need the database (countries, goods categories) run afterwards in the router.
 */
export function parseImport(dataset: ImportDataset, text: string): ParsedImport {
  let records;
  try {
    records = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvSyntaxError) return { ok: false, errors: [{ row: e.line, message: e.message }] };
    throw e;
  }
  const [header, ...body] = records;
  if (!header) return { ok: false, errors: [{ row: 1, message: 'The file is empty.' }] };

  const { required, optional } = IMPORT_COLUMNS[dataset];
  const names = header.cells.map((c) => c.trim().toLowerCase());
  const headerErrors: ImportRowError[] = [];
  for (const col of required) {
    if (!names.includes(col)) headerErrors.push({ row: 1, column: col, message: `The column "${col}" is missing.` });
  }
  names.forEach((n, i) => {
    if (![...required, ...optional].includes(n)) {
      headerErrors.push({ row: 1, column: header.cells[i], message: `The column "${header.cells[i]}" is not part of this file layout.` });
    } else if (names.indexOf(n) !== i) {
      headerErrors.push({ row: 1, column: n, message: `The column "${n}" appears twice.` });
    }
  });
  if (headerErrors.length) return { ok: false, errors: headerErrors };
  if (body.length === 0) return { ok: false, errors: [{ row: 2, message: 'The file has a header but no rows.' }] };
  if (body.length > IMPORT_MAX_ROWS) {
    return { ok: false, errors: [{ row: IMPORT_MAX_ROWS + 2, message: `A file can have at most ${IMPORT_MAX_ROWS} rows. Split it.` }] };
  }

  const errors: ImportRowError[] = [];
  const seen = new Map<string, number>();
  const rows: (FactorRow | CnCodeRow)[] = [];
  const lines: number[] = [];

  for (const rec of body) {
    if (errors.length >= MAX_ERRORS) break;
    if (rec.cells.length !== names.length) {
      errors.push({ row: rec.line, message: `This row has ${rec.cells.length} values; the header has ${names.length}.` });
      continue;
    }
    const cell = (col: string): string => {
      const i = names.indexOf(col);
      return i < 0 ? '' : rec.cells[i]!.trim();
    };
    const nullable = (col: string) => (cell(col) === '' ? null : cell(col));

    const parsed =
      dataset === 'factors'
        ? parseRow(FactorInput, rec.line, errors, FACTOR_COLUMN, {
            kind: cell('kind'),
            subject: cell('subject'),
            countryCode: nullable('country_code'),
            region: nullable('region'),
            year: cell('year') === '' ? null : /^\d+$/.test(cell('year')) ? Number(cell('year')) : cell('year'),
            component: nullable('component'),
            value: cell('value'),
            unit: cell('unit'),
            validFrom: cell('valid_from'),
            validTo: nullable('valid_to'),
            plausibleMin: nullable('plausible_min'),
            plausibleMax: nullable('plausible_max'),
            source: cell('source'),
            notes: nullable('notes'),
          })
        : parseRow(CnCodeRow, rec.line, errors, CN_COLUMN, {
            code: cell('cn_code'),
            description: cell('description'),
            goodsCategoryCode: cell('goods_category'),
          });
    if (!parsed) continue;

    const key = dataset === 'factors' ? factorKey(parsed as FactorInput) : (parsed as CnCodeRow).code;
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({ row: rec.line, message: `This row repeats line ${first}. Each ${dataset === 'factors' ? 'factor' : 'CN code'} can appear once.` });
      continue;
    }
    seen.set(key, rec.line);
    rows.push(dataset === 'factors' ? withSi(parsed as FactorInput) : (parsed as CnCodeRow));
    lines.push(rec.line);
  }

  if (errors.length) return { ok: false, errors };
  return dataset === 'factors'
    ? { ok: true, dataset, rows: rows as FactorRow[], lines }
    : { ok: true, dataset, rows: rows as CnCodeRow[], lines };
}

// API field → file column, so errors name the column the user sees.
const FACTOR_COLUMN: Record<string, string> = {
  kind: 'kind',
  subject: 'subject',
  countryCode: 'country_code',
  region: 'region',
  year: 'year',
  component: 'component',
  value: 'value',
  unit: 'unit',
  validFrom: 'valid_from',
  validTo: 'valid_to',
  plausibleMin: 'plausible_min',
  plausibleMax: 'plausible_max',
  source: 'source',
  notes: 'notes',
};
const CN_COLUMN: Record<string, string> = { code: 'cn_code', description: 'description', goodsCategoryCode: 'goods_category' };

function parseRow<S extends z.ZodType>(
  schema: S,
  line: number,
  errors: ImportRowError[],
  columns: Record<string, string>,
  input: Record<string, unknown>,
): z.infer<S> | null {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  for (const i of r.error.issues) {
    const field = String(i.path[0] ?? '');
    errors.push({ row: line, column: columns[field], message: i.message });
  }
  return null;
}

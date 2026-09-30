import { z } from 'zod';
import { DecimalString } from './decimal';
import { Provenance } from './enums';
import { type Dimension, type UnitId, UNITS, baseUnit, isUnitId, toBase, unitsFor } from './units';

/**
 * A numeric input as entered (G5, G7): value, unit, provenance, data source, and the
 * library default it came from when provenance is 'default'.
 */
export function quantityInput(dimension: Dimension | readonly Dimension[]) {
  const dims: readonly Dimension[] = typeof dimension === 'string' ? [dimension] : dimension;
  const allowed = dims.flatMap((d) => unitsFor(d));
  return z
    .object({
      value: DecimalString,
      unit: z
        .string()
        .refine((u): u is UnitId => isUnitId(u) && dims.includes(UNITS[u].dimension), {
          message: `Unit must be one of: ${allowed.join(', ')}.`,
        }),
      provenance: Provenance,
      source: z.string().trim().min(1, 'Enter the data source.'),
      defaultRef: z.uuid().optional(),
    })
    .refine((q) => q.provenance !== 'default' || q.defaultRef !== undefined, {
      message: 'A default value must reference the library entry it came from.',
      path: ['defaultRef'],
    });
}
export type QuantityInput = z.infer<ReturnType<typeof quantityInput>>;

/** The stored form: the entry plus its normalised base-unit value. */
export interface StoredQuantity extends QuantityInput {
  si: string;
  siUnit: UnitId;
}

export function normaliseQuantity(q: QuantityInput): StoredQuantity {
  const unit = q.unit as UnitId;
  return {
    ...q,
    si: toBase(q.value, unit).toString(),
    siUnit: baseUnit(UNITS[unit].dimension),
  };
}

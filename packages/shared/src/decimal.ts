import DecimalJs from 'decimal.js';
import { z } from 'zod';

/**
 * The only Decimal constructor the app uses (G6). 40 significant digits is far beyond
 * any template precision; rounding happens only at display/export.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalValue = DecimalJs.Value;

/** Decimals travel as strings in JSON and from Postgres `numeric`; never as JS numbers. */
export const DecimalString = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'Enter a number, using a dot as the decimal separator.');
export type DecimalString = z.infer<typeof DecimalString>;

export const toDecimal = (value: DecimalString | Decimal): Decimal => new Decimal(value);

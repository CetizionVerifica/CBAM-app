import { Decimal, type DecimalString, UNITS, type UnitId } from '@cbam/shared';

/**
 * The one way to show a quantity (design system 12): rounds with Decimal to the
 * template's decimals for the field, then applies locale separators. Components never
 * call Number(), toFixed() or toLocaleString() on quantities.
 *
 * `decimals` comes from the template field map once M12 defines it; callers pass it
 * explicitly until then.
 */
export function formatQuantity(
  value: DecimalString,
  unit: UnitId,
  decimals: number,
  locale: string = navigator.language,
): { number: string; unit: string } {
  const rounded = new Decimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(rounded as unknown as number); // Intl formats decimal strings exactly (ES2023)
  return { number, unit: UNITS[unit].label };
}

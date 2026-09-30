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

/**
 * A library value exactly as stored (no rounding: factors are inputs, not template
 * outputs), with locale separators. Keeps every decimal the source gave.
 */
export function formatExact(value: DecimalString, locale: string = navigator.language): string {
  const decimals = value.split('.')[1]?.length ?? 0;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value as unknown as number); // Intl formats decimal strings exactly (ES2023)
}

/** Display label for a unit id; unknown ids are shown as given. */
export const unitLabel = (unit: string): string => (unit in UNITS ? UNITS[unit as UnitId].label : unit);

/**
 * A business date ('YYYY-MM-DD') as "1 Jan 2026". Formatted in UTC so the day never shifts
 * with the viewer's time zone (M3-R8, AT4).
 */
export function formatDate(value: string, locale: string = navigator.language): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${value}T00:00:00Z`),
  );
}

/** A moment (timestamptz), in the viewer's time zone: "12 Oct 2026, 14:05". */
export function formatMoment(iso: string, locale: string = navigator.language): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/**
 * Calculation engine (M10). Pure: no DB, HTTP or clock access (M10-R3).
 * Formulas arrive with M10; Phase 1 only fixes the arithmetic foundation (G6).
 */
export { Decimal, type DecimalValue } from '@cbam/shared';

export const ENGINE_VERSION = '0.1.0';

import { Decimal, type DecimalValue } from './decimal';

/**
 * Central unit registry (G5). Every numeric input is stored as entered and as a
 * normalised value in the base unit of its dimension. All conversions are linear.
 * Base units follow the spec (section 5): t, TJ, MWh, Nm³, tCO₂e, fraction.
 */
export const DIMENSIONS = {
  mass: 't',
  energy: 'TJ',
  electricity: 'MWh',
  gas_volume: 'Nm3',
  emissions: 'tCO2e',
  ncv_mass: 'TJ/t',
  ncv_volume: 'TJ/Nm3',
  ef_energy: 'tCO2/TJ',
  ef_mass: 'tCO2/t',
  ef_electricity: 'tCO2/MWh',
  ef_volume: 'tCO2/Nm3',
  gwp: 'tCO2e/tGHG',
  see: 'tCO2e/t',
  see_electricity: 'tCO2e/MWh',
  carbon_content: 'tC/t',
  fraction: 'fraction',
} as const;
export type Dimension = keyof typeof DIMENSIONS;

interface UnitDef {
  dimension: Dimension;
  /** Multiply a value in this unit by this factor to get the base unit. */
  toBase: string;
  /** Display label with proper subscripts (design system 3.4). */
  label: string;
}

export const UNITS = {
  // mass
  kg: { dimension: 'mass', toBase: '0.001', label: 'kg' },
  t: { dimension: 'mass', toBase: '1', label: 't' },
  kt: { dimension: 'mass', toBase: '1000', label: 'kt' },
  // energy
  MJ: { dimension: 'energy', toBase: '0.000001', label: 'MJ' },
  GJ: { dimension: 'energy', toBase: '0.001', label: 'GJ' },
  TJ: { dimension: 'energy', toBase: '1', label: 'TJ' },
  // electricity
  kWh: { dimension: 'electricity', toBase: '0.001', label: 'kWh' },
  MWh: { dimension: 'electricity', toBase: '1', label: 'MWh' },
  GWh: { dimension: 'electricity', toBase: '1000', label: 'GWh' },
  // gas volume
  Nm3: { dimension: 'gas_volume', toBase: '1', label: 'Nm³' },
  kNm3: { dimension: 'gas_volume', toBase: '1000', label: '1000 Nm³' },
  // emissions
  kgCO2e: { dimension: 'emissions', toBase: '0.001', label: 'kgCO₂e' },
  tCO2e: { dimension: 'emissions', toBase: '1', label: 'tCO₂e' },
  // net calorific value
  'GJ/t': { dimension: 'ncv_mass', toBase: '0.001', label: 'GJ/t' },
  'MJ/kg': { dimension: 'ncv_mass', toBase: '0.001', label: 'MJ/kg' },
  'TJ/t': { dimension: 'ncv_mass', toBase: '1', label: 'TJ/t' },
  'GJ/Nm3': { dimension: 'ncv_volume', toBase: '0.001', label: 'GJ/Nm³' },
  'GJ/kNm3': { dimension: 'ncv_volume', toBase: '0.000001', label: 'GJ/1000 Nm³' },
  'TJ/Nm3': { dimension: 'ncv_volume', toBase: '1', label: 'TJ/Nm³' },
  // emission factors
  'tCO2/TJ': { dimension: 'ef_energy', toBase: '1', label: 'tCO₂/TJ' },
  'kgCO2/GJ': { dimension: 'ef_energy', toBase: '1', label: 'kgCO₂/GJ' },
  'tCO2/t': { dimension: 'ef_mass', toBase: '1', label: 'tCO₂/t' },
  'kgCO2/t': { dimension: 'ef_mass', toBase: '0.001', label: 'kgCO₂/t' },
  'tCO2/MWh': { dimension: 'ef_electricity', toBase: '1', label: 'tCO₂/MWh' },
  'kgCO2/kWh': { dimension: 'ef_electricity', toBase: '1', label: 'kgCO₂/kWh' },
  'gCO2/kWh': { dimension: 'ef_electricity', toBase: '0.001', label: 'gCO₂/kWh' },
  'tCO2/Nm3': { dimension: 'ef_volume', toBase: '1', label: 'tCO₂/Nm³' },
  'tCO2/kNm3': { dimension: 'ef_volume', toBase: '0.001', label: 'tCO₂/1000 Nm³' },
  // global warming potential: tonnes CO₂e per tonne of the gas
  'tCO2e/tGHG': { dimension: 'gwp', toBase: '1', label: 'tCO₂e/t gas' },
  // specific embedded emissions
  'tCO2e/t': { dimension: 'see', toBase: '1', label: 'tCO₂e/t' },
  'kgCO2e/t': { dimension: 'see', toBase: '0.001', label: 'kgCO₂e/t' },
  // electricity as a CBAM good is declared per MWh (goods category unit, review M4 F3)
  'tCO2e/MWh': { dimension: 'see_electricity', toBase: '1', label: 'tCO₂e/MWh' },
  // carbon content
  'tC/t': { dimension: 'carbon_content', toBase: '1', label: 'tC/t' },
  '%C': { dimension: 'carbon_content', toBase: '0.01', label: '% C' },
  // fractions
  fraction: { dimension: 'fraction', toBase: '1', label: '' },
  '%': { dimension: 'fraction', toBase: '0.01', label: '%' },
} as const satisfies Record<string, UnitDef>;

export type UnitId = keyof typeof UNITS;
export const UNIT_IDS = Object.keys(UNITS) as UnitId[];

export const isUnitId = (u: string): u is UnitId => Object.hasOwn(UNITS, u);

export const unitsFor = (dimension: Dimension): UnitId[] =>
  UNIT_IDS.filter((u) => UNITS[u].dimension === dimension);

export const baseUnit = (dimension: Dimension): UnitId => DIMENSIONS[dimension] as UnitId;

/** Converts a value to the base unit of its dimension. */
export function toBase(value: DecimalValue, unit: UnitId): Decimal {
  return new Decimal(value).times(UNITS[unit].toBase);
}

/** Converts between two units of the same dimension. */
export function convert(value: DecimalValue, from: UnitId, to: UnitId): Decimal {
  if (UNITS[from].dimension !== UNITS[to].dimension) {
    throw new Error(`Cannot convert ${from} to ${to}: different dimensions`);
  }
  return toBase(value, from).dividedBy(UNITS[to].toBase);
}

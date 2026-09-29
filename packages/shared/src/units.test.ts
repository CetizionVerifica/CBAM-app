import { describe, expect, it } from 'vitest';
import { convert, toBase, unitsFor } from './units';
import { normaliseQuantity, quantityInput } from './quantity';

describe('unit registry', () => {
  it('normalises spec section 5 examples exactly', () => {
    expect(toBase('48', 'GJ/t').toString()).toBe('0.048');
    expect(toBase('5000000', 'kWh').toString()).toBe('5000');
    expect(toBase('1500', 'kg').toString()).toBe('1.5');
    expect(toBase('250', 'GJ').toString()).toBe('0.25');
  });

  it('converts within a dimension and refuses across dimensions', () => {
    expect(convert('0.7', 'tCO2/MWh', 'gCO2/kWh').toString()).toBe('700');
    expect(() => convert('1', 't', 'TJ')).toThrow(/different dimensions/);
  });

  it('never uses floats', () => {
    expect(toBase('0.1', '%').plus(toBase('0.2', '%')).toString()).toBe('0.003');
  });

  it('lists units per dimension', () => {
    expect(unitsFor('ncv_mass')).toEqual(['GJ/t', 'MJ/kg', 'TJ/t']);
  });
});

describe('quantityInput', () => {
  const ncv = quantityInput('ncv_mass');

  it('accepts a measured value and stores original plus normalised', () => {
    const q = ncv.parse({ value: '48.000', unit: 'GJ/t', provenance: 'measured', source: 'Lab report 2026-03' });
    expect(normaliseQuantity(q)).toMatchObject({ value: '48.000', unit: 'GJ/t', si: '0.048', siUnit: 'TJ/t' });
  });

  it('rejects a unit from another dimension', () => {
    const r = ncv.safeParse({ value: '48', unit: 'MWh', provenance: 'measured', source: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects JS-number input and locale separators', () => {
    expect(ncv.safeParse({ value: 48, unit: 'GJ/t', provenance: 'measured', source: 'x' }).success).toBe(false);
    expect(ncv.safeParse({ value: '48,0', unit: 'GJ/t', provenance: 'measured', source: 'x' }).success).toBe(false);
  });

  it('requires a library reference for default values', () => {
    const r = ncv.safeParse({ value: '48', unit: 'GJ/t', provenance: 'default', source: 'Library' });
    expect(r.success).toBe(false);
  });
});

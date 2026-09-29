import { describe, expect, it } from 'vitest';
import { CsvSyntaxError, parseCsv } from './csv';
import { diffRecords } from './diff';
import { parseImport } from './import';

describe('parseCsv', () => {
  it('reads quoted values, escaped quotes, CRLF and a BOM, with line numbers', () => {
    const text = '﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n"multi\nline",z\n';
    expect(parseCsv(text)).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['x, y', 'say "hi"'] },
      { line: 4, cells: ['multi\nline', 'z'] },
    ]);
  });

  it('rejects an unclosed quote with its line', () => {
    expect(() => parseCsv('a,b\n"open,1\n')).toThrow(CsvSyntaxError);
    try {
      parseCsv('a,b\n"open,1\n');
    } catch (e) {
      expect((e as CsvSyntaxError).line).toBe(2);
    }
  });

  it('rejects text after a closing quote', () => {
    expect(() => parseCsv('"a"b,c')).toThrow(/closing quote/);
  });
});

const FACTOR_HEADER = 'kind,subject,country_code,region,year,component,value,unit,valid_from,valid_to,plausible_min,plausible_max,source,notes';

describe('parseImport — factors', () => {
  it('parses every kind and normalises to SI (G5)', () => {
    const csv = [
      FACTOR_HEADER,
      'ncv,Natural gas,,,,,48,GJ/t,2026-01-01,,44,50,IPCC 2006 Vol. 2 Table 1.2,',
      'grid_factor,electricity,IN,,2026,,700,gCO2/kWh,2026-01-01,2026-12-31,,,CEA baseline v20,',
      'default_see,72081000,CN,,,direct,2.1,tCO2e/t,2026-01-01,,,,Commission default values 2025,',
    ].join('\n');
    const r = parseImport('factors', csv);
    expect(r.ok).toBe(true);
    if (!r.ok || r.dataset !== 'factors') return;
    expect(r.lines).toEqual([2, 3, 4]);
    expect(r.rows[0]).toMatchObject({ kind: 'ncv', value: '48', unit: 'GJ/t', valueSi: '0.048', siUnit: 'TJ/t', plausibleMin: '44' });
    expect(r.rows[1]).toMatchObject({ kind: 'grid_factor', countryCode: 'IN', year: 2026, valueSi: '0.7', siUnit: 'tCO2/MWh' });
    expect(r.rows[2]).toMatchObject({ kind: 'default_see', component: 'direct', subject: '72081000' });
  });

  it('AT2: one malformed row rejects the whole file and names the line', () => {
    const csv = [
      FACTOR_HEADER,
      'ncv,Natural gas,,,,,48,GJ/t,2026-01-01,,,,IPCC,',
      'ncv,Coal,,,,,twenty,GJ/t,2026-01-01,,,,IPCC,',
      'gwp,N2O,,,,,265,tCO2e/tGHG,2026-01-01,,,,AR5,',
    ].join('\n');
    const r = parseImport('factors', csv);
    expect(r).toEqual({
      ok: false,
      errors: [{ row: 3, column: 'value', message: 'Enter a number, using a dot as the decimal separator.' }],
    });
  });

  it('applies the per-kind rules (M4-R6)', () => {
    const csv = [
      FACTOR_HEADER,
      'grid_factor,electricity,,,,,0.7,tCO2/MWh,2026-01-01,,,,x,',
      'ncv,Coal,,North,,,25,GJ/t,2026-01-01,,,,x,',
      'emission_factor,Coal,,,,,94.6,GJ/t,2026-01-01,,,,x,',
      'ncv,Coke,,,,,28,GJ/t,2026-01-01,2025-01-01,30,20,x,',
    ].join('\n');
    const r = parseImport('factors', csv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { row: 2, column: 'country_code', message: 'A grid emission factor needs a country.' },
      { row: 2, column: 'year', message: 'A grid emission factor needs a year.' },
      { row: 3, column: 'region', message: 'Only grid emission factors have a region.' },
      { row: 4, column: 'unit', message: 'Use one of these units for this kind (emission factor): tCO₂/TJ, kgCO₂/GJ, tCO₂/t, kgCO₂/t, tCO₂/Nm³, tCO₂/1000 Nm³.' },
      { row: 5, column: 'valid_to', message: 'The end date must be on or after the start date.' },
      { row: 5, column: 'plausible_max', message: 'The upper bound must be at least the lower bound.' },
    ]);
  });

  it('refuses a repeated key, a missing column, an unknown column and a short row', () => {
    const dup = parseImport('factors', [FACTOR_HEADER, 'gwp,N2O,,,,,265,tCO2e/tGHG,2026-01-01,,,,a,', 'gwp,N2O,,,,,298,tCO2e/tGHG,2026-01-01,,,,b,'].join('\n'));
    expect(dup).toMatchObject({ ok: false, errors: [{ row: 3, message: 'This row repeats line 2. Each factor can appear once.' }] });

    const header = parseImport('factors', 'kind,subject,value,unit,valid_from,colour\ngwp,N2O,1,tCO2e/tGHG,2026-01-01,red');
    expect(header).toMatchObject({
      ok: false,
      errors: [
        { row: 1, column: 'source', message: 'The column "source" is missing.' },
        { row: 1, column: 'colour', message: 'The column "colour" is not part of this file layout.' },
      ],
    });

    const short = parseImport('cn_codes', 'cn_code,description,goods_category\n72081000,Flat-rolled');
    expect(short).toMatchObject({ ok: false, errors: [{ row: 2, message: 'This row has 2 values; the header has 3.' }] });
  });

  it('never uses floats: 0.1 + 0.2 stays exact through SI conversion', () => {
    const r = parseImport('factors', [FACTOR_HEADER, 'ncv,A,,,,,0.1,GJ/t,2026-01-01,,,,x,', 'ncv,B,,,,,0.2,GJ/t,2026-01-01,,,,x,'].join('\n'));
    if (!r.ok || r.dataset !== 'factors') throw new Error('expected ok');
    expect(r.rows.map((x) => x.valueSi)).toEqual(['0.0001', '0.0002']);
  });
});

describe('parseImport — CN codes', () => {
  it('accepts the template’s spaced CN format', () => {
    const r = parseImport('cn_codes', 'CN_CODE,Description,Goods_Category\n"7208 10 00","Flat-rolled products, hot-rolled",iron_steel_products\n');
    expect(r).toEqual({
      ok: true,
      dataset: 'cn_codes',
      lines: [2],
      rows: [{ code: '72081000', description: 'Flat-rolled products, hot-rolled', goodsCategoryCode: 'iron_steel_products' }],
    });
  });
});

describe('diffRecords', () => {
  it('lists added, changed (with fields) and removed rows by key', () => {
    const d = diffRecords(
      [
        { key: 'a', label: 'A', fields: { value: '1', unit: 't' } },
        { key: 'b', label: 'B', fields: { value: '2', unit: 't' } },
      ],
      [
        { key: 'b', label: 'B', fields: { value: '2.5', unit: 't' } },
        { key: 'c', label: 'C', fields: { value: '3', unit: 't' } },
      ],
    );
    expect(d.added.map((r) => r.key)).toEqual(['c']);
    expect(d.changed).toEqual([{ key: 'b', label: 'B', before: { value: '2', unit: 't' }, after: { value: '2.5', unit: 't' }, fields: ['value'] }]);
    expect(d.removed.map((r) => r.key)).toEqual(['a']);
  });
});

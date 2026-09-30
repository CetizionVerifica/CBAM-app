import { describe, expect, it } from 'vitest';
import { GoodDataRequest, type ProcessFacts, ProductionRequest, UpdateProcessRequest, canComplete, processChecks, productionBalance } from './processes';

// M5 — pure checks (D20). Requirement IDs from
// .claude/skills/cbam-module-reviewer/references/modules/M05-process-goods.md

const base = (over: Partial<ProcessFacts> = {}): ProcessFacts => ({
  id: 'p1',
  name: 'Smelter',
  unit: 't',
  routes: [{ id: 'r1', label: 'Primary (electrolytic) smelting', amountSi: '1000' }],
  goods: [{ id: 'g1', label: '76011000 Aluminium, not alloyed', producedSi: '1000', soldEuSi: null, soldOtherSi: null, filledPositions: [2, 3, 4] }],
  qualifyingParameters: [
    { position: 2, name: 't scrap per t aluminium', required: true },
    { position: 3, name: '% non-aluminium elements', required: true },
    { position: 4, name: '% pre-consumer scrap', required: true },
  ],
  internalUses: [],
  nonCbamSi: null,
  tolerance: '0.005',
  ...over,
});

describe('M5-R3 production balance', () => {
  it('balances: activity level = goods + internal use + non-CBAM', () => {
    const p = base({
      routes: [
        { id: 'r1', label: 'A', amountSi: '600' },
        { id: 'r2', label: 'B', amountSi: '400' },
      ],
      goods: [{ ...base().goods[0]!, producedSi: '700' }],
      internalUses: [{ id: 'u1', consumerName: 'Rolling', amountSi: '250' }],
      nonCbamSi: '50',
    });
    expect(productionBalance(p)).toMatchObject({ activityLevel: '1000', goods: '700', internalUse: '250', nonCbam: '50', difference: '0', withinTolerance: true });
    expect(processChecks(p)).toEqual([]);
  });

  it('AT2: CN quantities of 1,200 t against an activity level of 1,000 t raise a critical check', () => {
    const checks = processChecks(base({ goods: [{ ...base().goods[0]!, producedSi: '1200' }] }));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ ruleId: 'M5-C05', severity: 'critical', record: { type: 'production_process', id: 'p1' } });
    expect(checks[0]!.message).toContain('add up to 1,200 t, but the activity level is 1,000 t');
    expect(canComplete(checks)).toBe(false);
  });

  it('accepts a difference within the tolerance, inclusive, and rejects one just beyond', () => {
    expect(processChecks(base({ goods: [{ ...base().goods[0]!, producedSi: '995' }] }))).toEqual([]);
    expect(processChecks(base({ goods: [{ ...base().goods[0]!, producedSi: '1005' }] }))).toEqual([]);
    expect(processChecks(base({ goods: [{ ...base().goods[0]!, producedSi: '994.999' }] }))[0]?.ruleId).toBe('M5-C05');
  });

  it('uses decimals, not floats: 0.1 + 0.2 balances 0.3 exactly with zero tolerance', () => {
    const p = base({
      tolerance: '0',
      routes: [{ id: 'r1', label: null, amountSi: '0.3' }],
      goods: [
        { ...base().goods[0]!, id: 'g1', producedSi: '0.1' },
        { ...base().goods[0]!, id: 'g2', producedSi: '0.2' },
      ],
    });
    expect(productionBalance(p)).toMatchObject({ difference: '0', withinTolerance: true });
  });

  it('skips the balance while amounts are missing, and flags the missing ones instead', () => {
    const p = base({ routes: [{ id: 'r1', label: 'Primary', amountSi: null }] });
    expect(productionBalance(p)).toMatchObject({ activityLevel: null, difference: null, withinTolerance: null });
    expect(processChecks(p).map((c) => c.ruleId)).toEqual(['M5-C01']);
  });

  it('a zero activity level with goods is out of balance', () => {
    expect(processChecks(base({ routes: [{ id: 'r1', label: null, amountSi: '0' }] })).map((c) => c.ruleId)).toEqual(['M5-C05']);
  });
});

describe('M5-R4 required qualifying parameters', () => {
  it('AT3: a fertiliser good without N content cannot be completed', () => {
    const checks = processChecks(
      base({
        name: 'Urea plant',
        goods: [{ id: 'g1', label: '31021010 Urea', producedSi: '1000', soldEuSi: null, soldOtherSi: null, filledPositions: [2] }],
        qualifyingParameters: [
          { position: 2, name: '% urea', required: true },
          { position: 3, name: '% N contained', required: true },
        ],
      }),
    );
    expect(checks).toMatchObject([{ ruleId: 'M5-C04', severity: 'critical', message: '31021010 Urea: enter % N contained.', record: { type: 'process_good', id: 'g1' } }]);
    expect(canComplete(checks)).toBe(false);
  });

  it('optional parameters are not required', () => {
    const p = base({ qualifyingParameters: [{ position: 1, name: 'The main reducing agent of the precursor, if known', required: false }], goods: [{ ...base().goods[0]!, filledPositions: [] }] });
    expect(processChecks(p)).toEqual([]);
  });
});

describe('other checks', () => {
  it('flags a process without routes or goods, and missing quantities', () => {
    const ids = processChecks(base({ routes: [], goods: [] })).map((c) => c.ruleId);
    expect(ids).toEqual(['M5-C01', 'M5-C02']);
    expect(processChecks(base({ goods: [{ ...base().goods[0]!, producedSi: null }] })).map((c) => c.ruleId)).toEqual(['M5-C03']);
  });

  it('warns when sales exceed production and when an internal use has no amount; warnings do not block', () => {
    const checks = processChecks(
      base({
        goods: [{ ...base().goods[0]!, producedSi: '1000', soldEuSi: '800', soldOtherSi: '300' }],
        internalUses: [{ id: 'u1', consumerName: 'Rolling', amountSi: null }],
      }),
    );
    expect(checks.map((c) => [c.ruleId, c.severity])).toEqual([
      ['M5-C07', 'warning'],
      ['M5-C06', 'warning'],
    ]);
    expect(canComplete(checks)).toBe(true);
  });
});

describe('request schemas', () => {
  const q = { value: '12.5', unit: 't', provenance: 'measured', source: 'Weighbridge log' };
  it('amounts are non-negative quantities in mass or electricity units', () => {
    expect(ProductionRequest.safeParse({ routes: [{ routeId: '9b2f7c1e-4d3a-4e8b-9c6d-2a1b3c4d5e6f', amount: q }], nonCbam: null, internalUses: [] }).success).toBe(true);
    expect(ProductionRequest.safeParse({ routes: [{ routeId: '9b2f7c1e-4d3a-4e8b-9c6d-2a1b3c4d5e6f', amount: { ...q, value: '-1' } }], nonCbam: null, internalUses: [] }).success).toBe(false);
    expect(ProductionRequest.safeParse({ routes: [], nonCbam: { ...q, unit: 'TJ' }, internalUses: [] }).success).toBe(false);
    expect(ProductionRequest.safeParse({ routes: [], nonCbam: { ...q, unit: 'MWh' }, internalUses: [] }).success).toBe(true);
  });
  it('a parameter takes text or a number, not both; numbers are % or t/t', () => {
    const ok = GoodDataRequest.safeParse({ produced: q, soldEu: null, soldOther: null, parameters: [{ position: 3, quantity: { ...q, unit: '%', value: '46.2' } }] });
    expect(ok.success).toBe(true);
    const both = GoodDataRequest.safeParse({ produced: null, soldEu: null, soldOther: null, parameters: [{ position: 3, text: 'x', quantity: { ...q, unit: '%' } }] });
    expect(both.success).toBe(false);
    const wrongUnit = GoodDataRequest.safeParse({ produced: null, soldEu: null, soldOther: null, parameters: [{ position: 3, quantity: q }] });
    expect(wrongUnit.success).toBe(false);
  });
  it('an update must change something besides confirm', () => {
    expect(UpdateProcessRequest.safeParse({ confirm: true }).success).toBe(false);
    expect(UpdateProcessRequest.safeParse({ name: 'Cast house' }).data).toEqual({ name: 'Cast house', confirm: false });
  });
});

import { describe, expect, it } from 'vitest';
import { formatQuantity } from './format';

describe('formatQuantity', () => {
  it('rounds half up with Decimal and keeps trailing zeros', () => {
    expect(formatQuantity('1.49645', 'tCO2e', 4, 'en-GB')).toEqual({ number: '1.4965', unit: 'tCO₂e' });
    expect(formatQuantity('1.79', 'tCO2e', 4, 'en-GB').number).toBe('1.7900');
  });

  it('applies locale separators without float error', () => {
    expect(formatQuantity('2692.8', 'tCO2e', 1, 'en-GB').number).toBe('2,692.8');
    expect(formatQuantity('2692.8', 'tCO2e', 1, 'de-DE').number).toBe('2.692,8');
    expect(formatQuantity('12345678901234567.25', 't', 2, 'en-GB').number).toBe('12,345,678,901,234,567.25');
  });
});

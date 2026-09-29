import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatQuantity } from './format';

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

describe('formatDate (M3-R8, AT4)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('shows 2026-01-01 to 2026-12-31 identically in UTC+5:30 and UTC−5', () => {
    const show = (tz: string) => {
      vi.stubEnv('TZ', tz);
      return [formatDate('2026-01-01', 'en-GB'), formatDate('2026-12-31', 'en-GB')];
    };
    expect(show('Asia/Kolkata')).toEqual(['1 Jan 2026', '31 Dec 2026']);
    expect(show('America/New_York')).toEqual(['1 Jan 2026', '31 Dec 2026']);
  });
});

import { describe, expect, it } from 'vitest';
import { Decimal } from './index';

// calculation-reference.md, "Float trap test": two process streams, AD 0.1 and 0.2, EF = CF = 1.
describe('float trap', () => {
  it('sums 0.1 and 0.2 to exactly 0.3', () => {
    const em = (ad: string) => new Decimal(ad).times('1').times('1');
    expect(em('0.1').plus(em('0.2')).toString()).toBe('0.3');
  });
});

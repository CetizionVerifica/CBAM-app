import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeriodInput, PeriodTransitionRequest, periodActionsFor, periodEndDate, periodLabel } from './periods';

describe('M3-R2 period dates', () => {
  it('a period is 12 months', () => {
    expect(periodEndDate('2026-01-01')).toBe('2026-12-31');
    expect(periodEndDate('2026-04-01')).toBe('2027-03-31');
    expect(periodEndDate('2027-03-01')).toBe('2028-02-29'); // leap year
    expect(periodEndDate('2026-07-15')).toBe('2027-07-14');
  });

  it('matches the database for 29 February (clamped to 28 February, then one day back)', () => {
    // select ('2028-02-29'::date + interval '1 year' - interval '1 day')::date → 2029-02-27
    expect(periodEndDate('2028-02-29')).toBe('2029-02-27');
  });

  it('calendar year needs no justification; other periods do', () => {
    expect(PeriodInput.safeParse({ startDate: '2026-01-01', endDate: '2026-12-31' }).success).toBe(true);
    const r = PeriodInput.safeParse({ startDate: '2026-04-01', endDate: '2027-03-31' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ['justification'] });
    expect(
      PeriodInput.safeParse({ startDate: '2026-04-01', endDate: '2027-03-31', justification: 'Financial year April to March' }).success,
    ).toBe(true);
  });

  it('computes the end date correctly for any year (review M3 F2)', () => {
    expect(periodEndDate('0050-01-01')).toBe('0050-12-31');
    expect(periodEndDate('2099-03-01')).toBe('2100-02-28');
  });

  it('refuses start dates outside 2023–2100 (review M3 F2)', () => {
    for (const startDate of ['0050-01-01', '1950-01-01', '2022-12-01', '2101-01-01']) {
      const r = PeriodInput.safeParse({ startDate, endDate: periodEndDate(startDate), justification: 'x' });
      expect(r.error?.issues, startDate).toEqual([
        expect.objectContaining({ path: ['startDate'], message: 'Choose a start date between 2023 and 2100.' }),
      ]);
    }
    expect(PeriodInput.safeParse({ startDate: '2023-01-01', endDate: '2023-12-31' }).success).toBe(true);
    expect(PeriodInput.safeParse({ startDate: '2100-12-31', endDate: '2101-12-30', justification: 'x' }).success).toBe(true);
  });

  it('rejects a period that is not 12 months', () => {
    const r = PeriodInput.safeParse({ startDate: '2026-01-01', endDate: '2026-06-30' });
    expect(r.error?.issues[0]).toMatchObject({ path: ['endDate'], message: 'A reporting period is 12 months: it ends on 2026-12-31.' });
  });
});

describe('M3-R8 / AT4 dates do not shift with the time zone', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('labels and end dates are identical in UTC+5:30 and UTC−5', () => {
    const out = (tz: string) => {
      vi.stubEnv('TZ', tz); // Node re-reads TZ when it is assigned
      expect(new Date('2026-01-01T00:00:00Z').getTimezoneOffset()).toBe(tz === 'Asia/Kolkata' ? -330 : 300);
      return [periodEndDate('2026-01-01'), periodLabel('2026-01-01', '2026-12-31'), periodLabel('2026-04-01', '2027-03-31')];
    };
    const india = out('Asia/Kolkata');
    const newYork = out('America/New_York');
    expect(india).toEqual(newYork);
    expect(india).toEqual(['2026-12-31', '2026', 'Apr 2026 – Mar 2027']);
  });
});

describe('M3-R3 status machine', () => {
  it('forward steps by role, back to draft only by a consultant', () => {
    expect(periodActionsFor('consultant', 'draft')).toEqual(['submit']);
    expect(periodActionsFor('reviewer', 'draft')).toEqual([]);
    expect(periodActionsFor('reviewer', 'in_review')).toEqual(['approve']);
    expect(periodActionsFor('consultant', 'in_review')).toEqual(['approve', 'reopen']);
    expect(periodActionsFor('platform_admin', 'approved')).toEqual(['issue']);
    expect(periodActionsFor('consultant', 'approved')).toEqual(['issue', 'reopen']);
    expect(periodActionsFor('consultant', 'issued')).toEqual([]);
    expect(periodActionsFor('contributor', 'draft')).toEqual([]);
  });

  it('returning to draft needs a reason', () => {
    expect(PeriodTransitionRequest.safeParse({ action: 'reopen' }).success).toBe(false);
    expect(PeriodTransitionRequest.safeParse({ action: 'reopen', reason: '  ' }).success).toBe(false);
    expect(PeriodTransitionRequest.safeParse({ action: 'reopen', reason: 'Wrong gas meter reading' }).success).toBe(true);
    expect(PeriodTransitionRequest.safeParse({ action: 'submit' }).success).toBe(true);
  });
});

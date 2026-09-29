import { z } from 'zod';
import type { UserRole } from './enums';
import { type PeriodStatus, LOCKED_PERIOD_STATUSES } from './enums';
import { optionalText } from './fields';
import { IsoDate } from './library';

/**
 * M3 — reporting periods. Dates are 'YYYY-MM-DD' strings from end to end: the database
 * column is `date`, the driver returns it unparsed, and nothing converts it to a Date in a
 * local time zone (M3-R8).
 */

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Last day of the 12-month period that starts on `start` (M3-R2). Same arithmetic as the
 * database check `start + interval '1 year' - interval '1 day'`: one year on, with the day
 * clamped to the month's length (29 Feb → 28 Feb), then one day back.
 */
export function periodEndDate(start: string): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y + 1, m - 1, Math.min(d, daysInMonth(y + 1, m))));
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

/** M3-R2: the default period is a calendar year. */
export const isCalendarYear = (start: string): boolean => start.endsWith('-01-01');

/** "2026" for a calendar year, "Apr 2026 – Mar 2027" otherwise; never shifted by time zone. */
export function periodLabel(start: string, end: string, locale = 'en-GB'): string {
  if (isCalendarYear(start) && end === periodEndDate(start)) return start.slice(0, 4);
  const month = (v: string) =>
    new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${v}T00:00:00Z`));
  return `${month(start)} – ${month(end)}`;
}

// ---------------------------------------------------------------------------
// Status machine (M3-R3). The database trigger app.guard_period_version enforces the same.
// ---------------------------------------------------------------------------

export type PeriodAction = 'submit' | 'approve' | 'issue' | 'reopen';

export const PERIOD_TRANSITIONS: Record<
  PeriodAction,
  { from: readonly PeriodStatus[]; to: PeriodStatus; roles: readonly UserRole[]; label: string; needsReason: boolean }
> = {
  submit: { from: ['draft'], to: 'in_review', roles: ['platform_admin', 'consultant'], label: 'Submit for review', needsReason: false },
  approve: { from: ['in_review'], to: 'approved', roles: ['platform_admin', 'consultant', 'reviewer'], label: 'Approve period', needsReason: false },
  issue: { from: ['approved'], to: 'issued', roles: ['platform_admin', 'consultant'], label: 'Issue period', needsReason: false },
  // Back-transitions go only to draft, only by a consultant, with a reason.
  reopen: { from: ['in_review', 'approved'], to: 'draft', roles: ['consultant'], label: 'Return to draft', needsReason: true },
};

/** Actions this role can take on a version in this status (the UI shows only these). */
export const periodActionsFor = (role: UserRole, status: PeriodStatus): PeriodAction[] =>
  (Object.keys(PERIOD_TRANSITIONS) as PeriodAction[]).filter((a) => {
    const t = PERIOD_TRANSITIONS[a];
    return t.from.includes(status) && t.roles.includes(role);
  });

export const isPeriodLocked = (status: PeriodStatus): boolean => LOCKED_PERIOD_STATUSES.includes(status);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const Justification = optionalText(2000);

/** Open or clone a period (M3-R1, R2, R6). The end date must be the computed one. */
export const PeriodInput = z
  .object({ startDate: IsoDate, endDate: IsoDate, justification: Justification })
  .superRefine((v, ctx) => {
    const end = periodEndDate(v.startDate);
    if (v.endDate !== end) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: `A reporting period is 12 months: it ends on ${end}.` });
    }
    if (!isCalendarYear(v.startDate) && !v.justification) {
      ctx.addIssue({
        code: 'custom',
        path: ['justification'],
        message: 'Say why this period does not follow the calendar year.',
      });
    }
  });
export type PeriodInput = z.infer<typeof PeriodInput>;

export const PeriodTransitionRequest = z
  .object({
    action: z.enum(['submit', 'approve', 'issue', 'reopen']),
    reason: optionalText(2000),
  })
  .superRefine((v, ctx) => {
    if (PERIOD_TRANSITIONS[v.action].needsReason && !v.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why this period goes back to draft.' });
    }
  });
export type PeriodTransitionRequest = z.infer<typeof PeriodTransitionRequest>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface PeriodVersionSummary {
  id: string;
  versionNo: number;
  status: PeriodStatus;
  libraryVersion: { id: string; code: string };
  templateVersion: { id: string; code: string };
  basedOnVersionNo: number | null;
  approvedAt: string | null;
  issuedAt: string | null;
  createdAt: string;
}

export interface PeriodSummary {
  id: string;
  installationId: string;
  startDate: string;
  endDate: string;
  justification: string | null;
  /** The newest version: the one people work on. */
  latest: PeriodVersionSummary;
  versionCount: number;
}

export interface PeriodStatusChange {
  id: string;
  versionNo: number;
  fromStatus: PeriodStatus | null;
  toStatus: PeriodStatus;
  reason: string | null;
  changedAt: string;
  changedBy: string | null;
}

export interface PeriodDetail extends Omit<PeriodSummary, 'latest'> {
  clientId: string;
  clientName: string;
  installationName: string;
  versions: PeriodVersionSummary[];
  history: PeriodStatusChange[];
  /** Dates can change only while the period has one version, in draft. */
  datesEditable: boolean;
}

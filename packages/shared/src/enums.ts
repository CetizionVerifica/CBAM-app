import { z } from 'zod';

// Spec section 2 / M1-R1. One role per user (Phase 1 decision D5).
export const USER_ROLES = ['platform_admin', 'consultant', 'contributor', 'reviewer', 'recipient'] as const;
export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;

// Spec 4.2 / M3-R3. Held per period version (decision D2).
export const PERIOD_STATUSES = ['draft', 'in_review', 'approved', 'issued'] as const;
export const PeriodStatus = z.enum(PERIOD_STATUSES);
export type PeriodStatus = z.infer<typeof PeriodStatus>;

export const LOCKED_PERIOD_STATUSES: readonly PeriodStatus[] = ['approved', 'issued'];

// G7: every numeric parameter carries one of these.
export const PROVENANCES = ['measured', 'estimated', 'default'] as const;
export const Provenance = z.enum(PROVENANCES);
export type Provenance = z.infer<typeof Provenance>;

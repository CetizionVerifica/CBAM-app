import { z } from 'zod';
import { USER_ROLES, type UserRole } from './enums';

/**
 * Access rules shared by API and UI (M1-R3, G2). The API enforces them; the UI only uses
 * them to hide actions a user cannot take. RLS in the database is the second line.
 */

export const ROLE_LABELS: Record<UserRole, string> = {
  platform_admin: 'Platform admin',
  consultant: 'Consultant',
  contributor: 'Data contributor',
  reviewer: 'Reviewer / verifier',
  recipient: 'Report recipient',
};

/** M1-R5: two-factor authentication is mandatory for these roles. */
export const ROLES_REQUIRING_MFA: readonly UserRole[] = ['platform_admin', 'consultant'];

/** Which roles each role may invite (and a consultant may only manage these). */
export const INVITABLE_ROLES: Record<UserRole, readonly UserRole[]> = {
  platform_admin: USER_ROLES,
  consultant: ['contributor', 'reviewer', 'recipient'],
  contributor: [],
  reviewer: [],
  recipient: [],
};

export const PERMISSIONS = {
  'users.list': ['platform_admin', 'consultant'],
  'users.invite': ['platform_admin', 'consultant'],
  'users.update': ['platform_admin'],
  'users.deactivate': ['platform_admin'],
  // M2: create/edit/delete clients, installations, importers; manage assignments.
  'registry.write': ['platform_admin', 'consultant'],
  'assignments.manage': ['platform_admin', 'consultant'],
  // M4: edit drafts, import files, publish library versions (M4-R5, AT3) — and only in the
  // platform operator tenant (decision D12), which the API and RLS check separately.
  'library.write': ['platform_admin'],
  // M4-R5: client-specific factor overrides.
  'overrides.propose': ['platform_admin', 'consultant'],
  'overrides.decide': ['platform_admin'],
  // M3: open, clone and re-version reporting periods, and edit their dates. Status changes
  // have their own role lists (PERIOD_TRANSITIONS in periods.ts).
  'periods.manage': ['platform_admin', 'consultant'],
} as const satisfies Record<string, readonly UserRole[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: UserRole, permission: Permission): boolean =>
  (PERMISSIONS[permission] as readonly UserRole[]).includes(role);

// ---------------------------------------------------------------------------
// Request schemas. Messages are the ones the UI shows (design system 5.2, 9).
// ---------------------------------------------------------------------------

const Email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const DisplayName = z.string().trim().min(1, 'Enter a name.').max(200, 'Use at most 200 characters.');

/** NIST 800-63B: length over composition rules; no truncation. */
export const Password = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.');

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1, 'Enter your password.').max(128),
});

export const TotpCode = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');
export const RecoveryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-7]{5}-?[A-Z2-7]{5}$/, 'Enter a recovery code like ABCDE-FGHIJ.');

export const MfaEnableRequest = z.object({ code: TotpCode });
export const MfaVerifyRequest = z.union([
  z.object({ code: TotpCode }),
  z.object({ recoveryCode: RecoveryCode }),
]);

export const AcceptInvitationRequest = z.object({
  token: z.string().min(20).max(200),
  displayName: DisplayName,
  password: Password,
});

export const InviteUserRequest = z.object({
  email: Email,
  displayName: DisplayName,
  role: z.enum(USER_ROLES),
});

export const UpdateUserRequest = z
  .object({ displayName: DisplayName.optional(), role: z.enum(USER_ROLES).optional() })
  .refine((v) => v.displayName !== undefined || v.role !== undefined, 'Change at least one field.');

export const DeactivateUserRequest = z.object({
  reason: z.string().trim().min(1, 'Say why this user is being deactivated.').max(500),
});

// ---------------------------------------------------------------------------
// Response shapes.
// ---------------------------------------------------------------------------

/** Where the session stands on 2FA; the UI routes on this. */
export type MfaState = 'verified' | 'required' | 'setup_required' | 'not_required';

export interface SessionUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface MeResponse {
  user: SessionUser;
  mfa: MfaState;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: 'invited' | 'active' | 'deactivated';
  twoFactorEnabled: boolean;
  createdAt: string;
}

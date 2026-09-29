import { type Permission, type UserRole, can } from '@cbam/shared';
import { Briefcase, type LucideIcon, Users } from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Hidden when the role lacks this permission. Display only — the API enforces access. */
  permission?: Permission;
}

/**
 * Side navigation (design system 4). The "This period" workflow steps arrive with M3 and
 * later modules; only built screens are listed so there are no dead links.
 */
export const NAV_GROUPS: NavItem[][] = [
  [{ label: 'Portfolio', to: '/', icon: Briefcase }],
  // Evidence, Audit trail (M13); Library (M4) — added as each module lands.
  [{ label: 'Users', to: '/settings/users', icon: Users, permission: 'users.list' }],
];

export const navFor = (role: UserRole): NavItem[][] =>
  NAV_GROUPS.map((g) => g.filter((i) => !i.permission || can(role, i.permission))).filter((g) => g.length > 0);

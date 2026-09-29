import { type Permission, type UserRole, can } from '@cbam/shared';
import { BookOpen, Briefcase, type LucideIcon, Users } from 'lucide-react';

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
  // Evidence, Audit trail (M13) — added as the module lands.
  [
    // M4: every role reads the library (decision D1); only the admin sees edit actions.
    { label: 'Library', to: '/library', icon: BookOpen },
    { label: 'Users', to: '/settings/users', icon: Users, permission: 'users.list' },
  ],
];

export const navFor = (role: UserRole): NavItem[][] =>
  NAV_GROUPS.map((g) => g.filter((i) => !i.permission || can(role, i.permission))).filter((g) => g.length > 0);

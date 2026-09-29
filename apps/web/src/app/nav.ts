import { BookOpen, Briefcase, FileSearch, History, type LucideIcon, Settings } from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

/**
 * Side navigation (design system 4). The "This period" workflow steps are added with
 * M3 and later modules; only built screens are listed so there are no dead links.
 */
export const NAV_GROUPS: NavItem[][] = [
  [{ label: 'Portfolio', to: '/', icon: Briefcase }],
  // Evidence, Audit trail (M13); Library (M4); Settings (M1) — enabled as each module lands.
];

// Referenced here so the icon choice from design system 3.7 is recorded with the nav.
export const PLANNED_ICONS = { evidence: FileSearch, audit: History, library: BookOpen, settings: Settings };

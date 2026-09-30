import type { Tx } from '../../platform/db';

/**
 * Extension points that later modules fill in (decision D6). M3 owns the period life
 * cycle but not the data inside a period, so the modules that own that data register here:
 *
 * - `approvalGuards` (M3-R7): M11 adds a guard that reports open critical issues. Approval
 *   is refused while any guard returns a blocker.
 * - `setupCopiers` (M3-R6): M5 and M6 copy the set-up (processes, source-stream
 *   definitions, CN codes) — never activity data — when a period is cloned.
 * - `versionCopiers` (M3-R5): every module that holds period data copies it into
 *   version n+1, so the new version starts from what was issued.
 *
 * A copier may return notes (plain sentences) about what it could not copy, for example set-up
 * that uses codes the new period's library no longer has (D23); clone returns them to the user.
 * Until M11 exists, approval has no blocking rules.
 */

export interface ApprovalBlocker {
  /** Plain-language rule, e.g. "2 blocking issues are open." */
  message: string;
  /** Where the user resolves it, e.g. the issues screen. */
  href?: string;
}

export type ApprovalGuard = (tx: Tx, periodVersionId: string) => Promise<ApprovalBlocker[]>;
export type PeriodCopier = (tx: Tx, from: { periodVersionId: string }, to: { periodVersionId: string }) => Promise<void | string[]>;

export interface PeriodHooks {
  approvalGuards: ApprovalGuard[];
  setupCopiers: PeriodCopier[];
  versionCopiers: PeriodCopier[];
}

export const emptyPeriodHooks = (): PeriodHooks => ({ approvalGuards: [], setupCopiers: [], versionCopiers: [] });

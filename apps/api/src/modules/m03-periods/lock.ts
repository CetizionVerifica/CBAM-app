import { type PeriodStatus, isPeriodLocked } from '@cbam/shared';
import type { Tx } from '../../platform/db';
import { AppError } from '../../platform/errors';

/**
 * API-level lock check (M3-R4, G4) for every route that writes period data. Call it inside
 * the request transaction before the write; the database trigger `app.guard_period_scoped`
 * holds even if a route forgets, and also covers a status change that lands between this
 * read and the write (it takes a share lock). Answers 404 when the caller cannot see the
 * version.
 */
export async function assertPeriodWritable(tx: Tx, periodVersionId: string): Promise<void> {
  const v = await tx
    .selectFrom('period_version')
    .select(['status', 'version_no'])
    .where('id', '=', periodVersionId)
    .executeTakeFirst();
  if (!v) throw new AppError(404, 'not_found', 'This reporting period does not exist or you do not have access to it.');
  if (isPeriodLocked(v.status as PeriodStatus)) throw lockedError(v.status as PeriodStatus);
}

export const lockedError = (status: PeriodStatus) =>
  new AppError(
    409,
    'locked',
    status === 'issued'
      ? 'This period is issued and read-only. Create a new version to make changes.'
      : 'This period is approved and read-only. Return it to draft or, once issued, create a new version to make changes.',
  );

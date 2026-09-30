import type { ProcessCheck } from '@cbam/shared';
import type { Tx } from '../../platform/db';
import { loadVersionProcesses } from './load';

/**
 * The M5 checks of a period version (D20), for M11 to persist as issues with the same rule
 * IDs (M11-R1, R6). Read under the caller's context like every other query.
 */
export async function processIssues(tx: Tx, periodVersionId: string): Promise<ProcessCheck[]> {
  const { details } = await loadVersionProcesses(tx, periodVersionId);
  return details.flatMap((d) => d.checks);
}

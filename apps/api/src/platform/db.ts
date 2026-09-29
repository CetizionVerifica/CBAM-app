import { Kysely, PostgresDialect, type Transaction, sql } from 'kysely';
import pg from 'pg';
import type { UserRole } from '@cbam/shared';
import type { DB } from '../db-types';

// `date` columns stay 'YYYY-MM-DD' strings: no time-zone shift at period boundaries (M3-R8).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// `numeric` and `int8` already arrive as strings; they go into Decimal, never Number (G6).

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

export function createDb(connectionString: string): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
}

/** Who is acting, set on every transaction; read by RLS policies and the audit trigger. */
export interface RequestContext {
  tenantId: string;
  userId: string;
  userRole: UserRole;
  requestId: string;
  /** Business verb for the audit log, matching the button and toast ("Approve period"). */
  action?: string;
  /** Reason text for back-transitions and overrides. */
  reason?: string;
}

/**
 * Runs `fn` in one transaction with the request context set (G1, G3).
 * All business reads and writes go through this; there is no other path to the data.
 */
export function withContext<T>(db: Db, ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`
      select set_config('app.tenant_id', ${ctx.tenantId}, true),
             set_config('app.user_id', ${ctx.userId}, true),
             set_config('app.user_role', ${ctx.userRole}, true),
             set_config('app.request_id', ${ctx.requestId}, true),
             set_config('app.action', ${ctx.action ?? ''}, true),
             set_config('app.reason', ${ctx.reason ?? ''}, true)
    `.execute(tx);
    return fn(tx);
  });
}

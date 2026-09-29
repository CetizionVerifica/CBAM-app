/**
 * Makes one tenant the platform operator: only its platform admins can change the shared
 * reference library (decision D12). Any previous operator loses the role. Runs as the
 * owner role (DATABASE_URL); the change is written to the audit log.
 *
 *   pnpm --filter @cbam/api set:platform-operator --slug cetizion
 */
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { z } from 'zod';
import { createDb } from '../platform/db';

const { values } = parseArgs({ options: { slug: { type: 'string' } } });
const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'lowercase letters, digits and hyphens') }).parse(values);
const { DATABASE_URL } = z.object({ DATABASE_URL: z.url() }).parse(process.env);
const db = createDb(DATABASE_URL);

try {
  const { rows } = await sql<{ id: string }>`select auth.set_platform_operator(${slug}) as id`.execute(db);
  console.log(`Platform operator: ${slug} (${rows[0]!.id})`);
} finally {
  await db.destroy();
}

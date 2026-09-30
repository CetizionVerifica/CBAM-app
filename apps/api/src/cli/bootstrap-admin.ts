/**
 * Creates a tenant and its first platform admin, and prints a single-use invitation link.
 * Runs as the owner role (DATABASE_URL), the only role allowed to call auth.bootstrap_tenant.
 *
 *   pnpm --filter @cbam/api bootstrap:admin --org "CETIZION" --slug cetizion \
 *     --email admin@example.com --name "Ada Admin" --platform-operator
 *
 * --platform-operator makes this tenant the one whose platform admins maintain the shared
 * reference library (decision D12). Move it later with `set:platform-operator`.
 */
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../platform/crypto';
import { createDb } from '../platform/db';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    slug: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    'platform-operator': { type: 'boolean', default: false },
  },
});

const Args = z.object({
  org: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'lowercase letters, digits and hyphens'),
  email: z.email(),
  name: z.string().min(1),
  'platform-operator': z.boolean(),
});
const Env = z.object({
  DATABASE_URL: z.url(),
  WEB_ORIGIN: z.url(),
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),
});

const args = Args.parse(values);
const env = Env.parse(process.env);
const db = createDb(env.DATABASE_URL);

try {
  const token = randomToken();
  const expires = new Date(Date.now() + env.INVITATION_TTL_HOURS * 3_600_000);
  const { rows } = await sql<{ tenant_id: string; user_id: string }>`
    select * from auth.bootstrap_tenant(${args.org}, ${args.slug}, ${args.email.toLowerCase()}, ${args.name},
                                        ${sha256Hex(token)}, ${expires})`.execute(db);
  console.log(`Tenant created: ${args.org} (${rows[0]!.tenant_id})`);
  if (args['platform-operator']) {
    await sql`select auth.set_platform_operator(${args.slug})`.execute(db);
    console.log('This tenant is the platform operator: its platform admins maintain the reference library.');
  }
  console.log(`Platform admin invited: ${args.email}`);
  console.log(`Invitation link (single use, expires ${expires.toISOString()}):`);
  console.log(`  ${env.WEB_ORIGIN}/invitation/${token}`);
} finally {
  await db.destroy();
}

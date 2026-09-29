import { z } from 'zod';

// All configuration comes from the environment (G10). Parsed once at start-up.
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_DATABASE_URL: z.url(),
  WEB_ORIGIN: z.url(),
  /**
   * Express 'trust proxy': hop count (e.g. 1 behind one load balancer) or a comma-separated
   * list of proxy addresses/subnets. Off by default so clients cannot choose their own IP
   * through X-Forwarded-For (review M1 F4).
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v): boolean | number | string[] =>
      v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v.split(',').map((s) => s.trim()),
    ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** 32 random bytes, base64. Encrypts TOTP secrets at rest. */
  TOTP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  SMTP_URL: z.url(),
  MAIL_FROM: z.string().min(3).default('CBAM reporting <no-reply@localhost>'),
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(12 * 60),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(120),
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return parsed.data;
}

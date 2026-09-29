import type { Config } from '../../config';
import type { Db } from '../../platform/db';
import type { Mailer } from '../../platform/mailer';

export interface AccessDeps {
  db: Db;
  mailer: Mailer;
  config: Pick<
    Config,
    | 'NODE_ENV'
    | 'WEB_ORIGIN'
    | 'TOTP_ENCRYPTION_KEY'
    | 'SESSION_TTL_MINUTES'
    | 'SESSION_IDLE_MINUTES'
    | 'INVITATION_TTL_HOURS'
  >;
}

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

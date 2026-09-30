import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from './config';
import { authRouter, usersRouter } from './modules/m01-access';
import { registryRouter } from './modules/m02-registry/registry.router';
import { type PeriodHooks, emptyPeriodHooks, periodsRouter } from './modules/m03-periods';
import { libraryRouter, overridesRouter } from './modules/m04-reference';
import { copyProcessData, copyProcessSetup, processesRouter } from './modules/m05-processes';
import { auditRouter, copyPeriodEvidence, evidenceRouter, verificationRouter } from './modules/m13-evidence';
import { authenticate, requireSameOrigin } from './platform/auth';
import type { Db } from './platform/db';
import { errorHandler, notFound } from './platform/errors';
import type { Mailer } from './platform/mailer';
import type { FileStore } from './platform/storage';

export interface AppDeps {
  db: Db;
  logger: Logger;
  mailer: Mailer;
  /** Evidence and report files (M12, M13); Cloudinary in dev and production, memory in tests. */
  files: FileStore;
  config: Config;
  /** What modules plug into the period life cycle (M3-R5, R6, R7). Tests may replace it. */
  periodHooks?: PeriodHooks;
}

export function createApp({ db, logger, mailer, files, config, periodHooks }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  // Library imports carry a CSV file (M4-R4) and parse their own larger body, after
  // authentication and the permission check (review M4 F8); everything else stays small.
  const jsonSmall = express.json({ limit: '1mb' });
  app.use((req, res, next) =>
    /^\/api\/v1\/library\/versions\/[^/]+\/imports$/.test(req.path) ? next() : jsonSmall(req, res, next),
  );
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );

  app.get('/health', async (_req, res) => {
    await sql`select 1`.execute(db);
    res.json({ status: 'ok' });
  });

  const api = express.Router();
  api.use(requireSameOrigin(config.WEB_ORIGIN));
  api.use(authenticate(db, config.SESSION_IDLE_MINUTES));

  // One router per module.
  const access = { db, mailer, config };
  api.use('/auth', authRouter(access));
  api.use('/users', usersRouter(access));
  api.use('/', registryRouter({ db }));
  const hooks = periodHooks ?? {
    ...emptyPeriodHooks(),
    setupCopiers: [copyProcessSetup],
    versionCopiers: [copyPeriodEvidence, copyProcessData],
  };
  api.use('/', periodsRouter({ db, hooks }));
  api.use('/', libraryRouter({ db }));
  api.use('/', overridesRouter({ db }));
  api.use('/', processesRouter({ db }));
  api.use('/', evidenceRouter({ db, files }));
  api.use('/', verificationRouter({ db }));
  api.use('/', auditRouter({ db }));

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

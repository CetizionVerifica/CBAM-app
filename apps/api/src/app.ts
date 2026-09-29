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
import { libraryRouter, overridesRouter } from './modules/m04-reference';
import { authenticate, requireSameOrigin } from './platform/auth';
import type { Db } from './platform/db';
import { errorHandler, notFound } from './platform/errors';
import type { Mailer } from './platform/mailer';

export interface AppDeps {
  db: Db;
  logger: Logger;
  mailer: Mailer;
  config: Config;
}

export function createApp({ db, logger, mailer, config }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  // Library imports carry a CSV file in the body (M4-R4); every other request stays small.
  const jsonSmall = express.json({ limit: '1mb' });
  const jsonImport = express.json({ limit: '10mb' });
  app.use((req, res, next) =>
    (/^\/api\/v1\/library\/versions\/[^/]+\/imports$/.test(req.path) ? jsonImport : jsonSmall)(req, res, next),
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
  api.use('/', libraryRouter({ db }));
  api.use('/', overridesRouter({ db }));

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

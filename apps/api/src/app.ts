import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from './platform/db';
import { errorHandler, notFound } from './platform/errors';

export interface AppDeps {
  db: Db;
  logger: Logger;
}

export function createApp({ db, logger }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
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

  // Module routers mount here: app.use('/api/v1/...', router) — one per module.

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

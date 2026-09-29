import { pino } from 'pino';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './platform/db';
import { smtpMailer } from './platform/mailer';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = createDb(config.APP_DATABASE_URL);
const mailer = smtpMailer(config.SMTP_URL, config.MAIL_FROM);
const app = createApp({ db, logger, mailer, config });

const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'API listening'));

const shutdown = () => {
  server.close(() => void db.destroy().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

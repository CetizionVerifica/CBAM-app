import { pino } from 'pino';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './platform/db';
import { smtpMailer } from './platform/mailer';
import { cloudinaryFileStore, unconfiguredFileStore } from './platform/storage';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = createDb(config.APP_DATABASE_URL);
const mailer = smtpMailer(config.SMTP_URL, config.MAIL_FROM);
const files = config.CLOUDINARY_URL
  ? cloudinaryFileStore(config.CLOUDINARY_URL, config.CLOUDINARY_FOLDER)
  : unconfiguredFileStore();
if (!config.CLOUDINARY_URL) logger.warn('CLOUDINARY_URL is not set: file uploads and downloads are unavailable');
const app = createApp({ db, logger, mailer, files, config });

const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'API listening'));

const shutdown = () => {
  server.close(() => void db.destroy().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

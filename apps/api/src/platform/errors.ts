import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Error with a plain-language message safe to show to the user (design system 5.7). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'not_found', 'This page or record does not exist.'));
};

// Messages never include other records' data (G10).
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Some fields are not valid. Fix them and try again.',
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Database refused on privilege or row-level security: the API check missed a case,
  // but the database held (G2). Answer as a normal permission error.
  if ((err as { code?: string }).code === '42501') {
    req.log?.warn({ err }, 'Database denied access');
    res.status(403).json({ error: { code: 'forbidden', message: 'Your role does not allow this action.' } });
    return;
  }
  req.log?.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on the server. Try again.' } });
};

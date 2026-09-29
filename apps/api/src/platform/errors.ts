import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Error with a plain-language message safe to show to the user (design system 5.7). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly issues?: { path: (string | number)[]; message: string }[],
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
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, ...(err.issues && { issues: err.issues }) },
    });
    return;
  }
  // Body parser: too large or not JSON.
  const bodyErr = err as { type?: string; status?: number };
  if (bodyErr.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'too_large', message: 'This request is too large.' } });
    return;
  }
  if (bodyErr.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'The request could not be read. Try again.' } });
    return;
  }
  // Locked record (published library version, approved period): the API check missed a
  // case, but the database trigger held (G4, M4-R2).
  if ((err as { code?: string }).code === '55000') {
    res.status(409).json({ error: { code: 'locked', message: 'This record is locked and cannot be changed.' } });
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

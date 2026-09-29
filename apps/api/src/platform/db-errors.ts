import { AppError } from './errors';

interface PgError {
  code?: string;
  constraint?: string;
}

/**
 * Turns a database constraint error into a plain-language API error. `unique` maps unique
 * constraint/index names to a message; FK failures on country columns become field errors.
 * Anything else is rethrown (row-level security denials become 403 in the error handler).
 */
export function mapDbError(e: unknown, unique: Record<string, string> = {}): never {
  const err = e as PgError;
  if (err.code === '23505' && err.constraint && unique[err.constraint]) {
    throw new AppError(409, 'duplicate', unique[err.constraint]!);
  }
  if (err.code === '23503' && err.constraint?.includes('country_code')) {
    throw new AppError(400, 'validation_failed', 'Some fields are not valid. Fix them and try again.', undefined, [
      { path: ['countryCode'], message: 'Choose a country from the list.' },
    ]);
  }
  throw e;
}

import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './api';

/**
 * Puts API validation messages on their fields (same Zod schema, same words — G8);
 * returns the message to show above the form when an error is not field-specific.
 */
export function applyServerError<T extends FieldValues>(e: unknown, setError: UseFormSetError<T>): string | null {
  if (e instanceof ApiError && e.issues.length > 0) {
    for (const issue of e.issues) setError(issue.path.join('.') as Path<T>, { message: issue.message });
    return null;
  }
  return e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
}

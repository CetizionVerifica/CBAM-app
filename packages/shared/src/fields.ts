import { z } from 'zod';

/** Optional free text: trimmed; empty means "not given" and is stored as null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const requiredText = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max, `Use at most ${max} characters.`);

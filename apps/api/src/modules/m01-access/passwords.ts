import { hash, verify } from '@node-rs/argon2';

// M1-R6: argon2id (the library default) with OWASP 2024 parameters.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export const verifyPassword = (passwordHash: string, password: string): Promise<boolean> =>
  verify(passwordHash, password).catch(() => false);

// Verified against when the email is unknown, so response time does not reveal accounts.
let dummy: Promise<string> | undefined;
export const dummyVerify = async (password: string): Promise<void> => {
  dummy ??= hashPassword('not-a-real-password-used-for-timing');
  await verifyPassword(await dummy, password);
};

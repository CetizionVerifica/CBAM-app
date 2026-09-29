import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** URL-safe random token for session cookies and invitation links (256 bits). */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** Tokens are stored only as their SHA-256 (sessions, invitations, recovery codes). */
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** AES-256-GCM for secrets at rest (TOTP). Output: iv.tag.ciphertext, base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Malformed sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP per RFC 6238 (HMAC-SHA1, 30 s steps, 6 digits), as used by authenticator apps. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export function hotp(key: Buffer, counter: number, digits = 6, algorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, '0');
}

export const totpAt = (secret: string, time: number, digits = 6): string =>
  hotp(base32Decode(secret), Math.floor(time / 30_000), digits);

/**
 * Returns the time step the code belongs to (current step or one either side, for clock
 * drift), or null. The caller records the step so the same code cannot be used twice.
 */
export function matchTotpStep(secret: string, code: string, now = Date.now()): number | null {
  const key = base32Decode(secret);
  const step = Math.floor(now / 30_000);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (const s of [step - 1, step, step + 1]) {
    const expected = Buffer.from(hotp(key, s));
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = s;
  }
  return matched;
}

export const verifyTotp = (secret: string, code: string, now = Date.now()): boolean =>
  matchTotpStep(secret, code, now) !== null;

export const otpauthUrl = (secret: string, account: string, issuer: string): string =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}` +
  `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Ten recovery codes like ABCDE-FGHIJ (50 bits each). */
export const generateRecoveryCodes = (): string[] =>
  Array.from({ length: 10 }, () => {
    const s = base32Encode(randomBytes(7)).slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });

export const normaliseRecoveryCode = (c: string): string => c.trim().toUpperCase().replace('-', '');

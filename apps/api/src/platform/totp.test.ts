import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, verifyTotp, totpAt } from './totp';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it('matches the RFC 4226 HOTP test values', () => {
    const key = Buffer.from('12345678901234567890');
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => expect(hotp(key, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 test values (8 digits)', () => {
    const key = Buffer.from('12345678901234567890');
    expect(hotp(key, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(key, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(key, Math.floor(2000000000 / 30), 8)).toBe('69279037');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('12345678901234567890');
    expect(base32Encode(buf)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('accepts one step of drift and rejects older codes', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = 1_800_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
  });
});

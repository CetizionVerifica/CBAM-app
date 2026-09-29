import { describe, expect, it } from 'vitest';
import { ClientInput, ImporterInput, InstallationInput } from './registry';

const installation = { nameEn: 'Jamnagar smelter', street: 'Plot 4, GIDC', city: 'Jamnagar', countryCode: 'IN' };
const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  r.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];

describe('M2-R4 validation', () => {
  it('AT2: rejects latitude 95', () => {
    const r = InstallationInput.safeParse({ ...installation, latitude: '95', longitude: '70' });
    expect(issues(r)).toEqual(['latitude: Latitude must be between −90 and 90.']);
  });

  it('accepts boundary coordinates and needs both or neither', () => {
    expect(InstallationInput.safeParse({ ...installation, latitude: '-90', longitude: '180' }).success).toBe(true);
    expect(issues(InstallationInput.safeParse({ ...installation, latitude: '22.47' }))).toEqual([
      'longitude: Enter both latitude and longitude, or neither.',
    ]);
  });

  it('rejects coordinates given as numbers or with more than 6 decimals', () => {
    expect(InstallationInput.safeParse({ ...installation, latitude: 22.47, longitude: 70.05 }).success).toBe(false);
    expect(InstallationInput.safeParse({ ...installation, latitude: '22.1234567', longitude: '70' }).success).toBe(false);
  });

  it('checks UN/LOCODE format and that it matches the country', () => {
    expect(InstallationInput.parse({ ...installation, unLocode: 'injga' }).unLocode).toBe('INJGA');
    expect(issues(InstallationInput.safeParse({ ...installation, unLocode: 'IN1GA' }))).toEqual([
      'unLocode: Enter a 5-character UN/LOCODE, like INJGA.',
    ]);
    expect(issues(InstallationInput.safeParse({ ...installation, unLocode: 'CNSHA' }))).toEqual([
      'unLocode: The UN/LOCODE must start with the installation’s country code.',
    ]);
  });

  it('checks EORI and email formats', () => {
    expect(ImporterInput.parse({ name: 'Hansa Handel GmbH', eori: 'de123456789012345' }).eori).toBe('DE123456789012345');
    expect(ImporterInput.safeParse({ name: 'X', eori: 'D1234' }).success).toBe(false);
    expect(ImporterInput.safeParse({ name: 'X', eori: 'DE1234567890123456' }).success).toBe(false);
    const client = { legalName: 'Aurum Metals Ltd', addressLine1: 'x', city: 'Mumbai', countryCode: 'IN', contactName: 'R', contactEmail: 'not-an-email' };
    expect(issues(ClientInput.safeParse(client))).toEqual(['contactEmail: Enter a valid email address.']);
  });

  it('stores empty optional fields as null', () => {
    const v = InstallationInput.parse({ ...installation, nameLocal: '  ', unLocode: '', latitude: '', longitude: '' });
    expect(v).toMatchObject({ nameLocal: null, unLocode: null, latitude: null, longitude: null });
  });
});

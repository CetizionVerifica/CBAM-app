import { z } from 'zod';
import { Decimal, DecimalString } from './decimal';

/**
 * M2 — client, installation and EU importer. Shared by API and forms (G8): the API
 * validates the merged record (existing + patch) against the full schema, so cross-field
 * rules hold for partial updates too.
 */

/** Optional free text: trimmed; empty means "not given" and is stored as null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const requiredText = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max, `Use at most ${max} characters.`);

const Email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const optionalEmail = z
  .union([z.literal(''), Email])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

export const CountryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Choose a country from the list.');

/** UN/LOCODE: country code + 3 characters (A–Z, 2–9), e.g. INJGA (M2-R4). */
export const UnLocode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}[A-Z2-9]{3}$/, 'Enter a 5-character UN/LOCODE, like INJGA.');

/** EORI: 2-letter country code + up to 15 letters or digits (M2-R4). */
export const Eori = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}[A-Z0-9]{1,15}$/, 'Enter an EORI number: 2-letter country code, then up to 15 letters or digits.');

const coordinate = (limit: number, label: string) =>
  DecimalString.refine((v) => new Decimal(v).abs().lte(limit), `${label} must be between −${limit} and ${limit}.`)
    .refine((v) => (v.split('.')[1]?.length ?? 0) <= 6, `${label} can have at most 6 decimal places.`);

const optionalCoordinate = (limit: number, label: string) =>
  z
    .union([z.literal(''), coordinate(limit, label)])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

// ---------------------------------------------------------------------------
// Client (operator). Not in the template (decision D3).
// ---------------------------------------------------------------------------

export const ClientFields = z.object({
  legalName: requiredText(300, 'Enter the operator’s legal name.'),
  registrationNo: optionalText(100),
  addressLine1: requiredText(300, 'Enter the street address.'),
  addressLine2: optionalText(300),
  postcode: optionalText(40),
  city: requiredText(200, 'Enter the city.'),
  countryCode: CountryCode,
  contactName: requiredText(200, 'Enter a contact person.'),
  contactEmail: Email,
  contactPhone: optionalText(50),
});
export const ClientInput = ClientFields;
export const ClientPatch = ClientFields.partial().refine((v) => Object.keys(v).length > 0, 'Change at least one field.');
export type ClientInput = z.infer<typeof ClientInput>;

// ---------------------------------------------------------------------------
// Installation. Field → template cell map: docs/mappings/template-A_InstData.md.
// ---------------------------------------------------------------------------

export const InstallationFields = z.object({
  nameLocal: optionalText(300),
  nameEn: requiredText(300, 'Enter the installation name in English.'),
  street: requiredText(300, 'Enter the street and number.'),
  economicActivity: optionalText(300),
  postcode: optionalText(40),
  poBox: optionalText(40),
  city: requiredText(200, 'Enter the city.'),
  countryCode: CountryCode,
  unLocode: z
    .union([z.literal(''), UnLocode])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  latitude: optionalCoordinate(90, 'Latitude'),
  longitude: optionalCoordinate(180, 'Longitude'),
  authRepName: optionalText(200),
  authRepEmail: optionalEmail,
  authRepPhone: optionalText(50),
  permitNo: optionalText(100),
});

type InstallationShape = z.infer<typeof InstallationFields>;
const installationRules = <T extends z.ZodType<InstallationShape>>(schema: T) =>
  schema
    .refine((v) => !v.unLocode || v.unLocode.startsWith(v.countryCode), {
      message: 'The UN/LOCODE must start with the installation’s country code.',
      path: ['unLocode'],
    })
    .refine((v) => (v.latitude == null) === (v.longitude == null), {
      message: 'Enter both latitude and longitude, or neither.',
      path: ['longitude'],
    });

export const InstallationInput = installationRules(InstallationFields);
export const InstallationPatch = InstallationFields.partial().refine(
  (v) => Object.keys(v).length > 0,
  'Change at least one field.',
);
export type InstallationInput = z.infer<typeof InstallationInput>;

// ---------------------------------------------------------------------------
// EU importer.
// ---------------------------------------------------------------------------

export const ImporterFields = z.object({
  name: requiredText(300, 'Enter the importer’s name.'),
  eori: Eori,
  addressLine1: optionalText(300),
  postcode: optionalText(40),
  city: optionalText(200),
  countryCode: CountryCode.nullable().optional(),
  contactName: optionalText(200),
  contactEmail: optionalEmail,
});
export const ImporterInput = ImporterFields;
export const ImporterPatch = ImporterFields.partial().refine((v) => Object.keys(v).length > 0, 'Change at least one field.');
export type ImporterInput = z.infer<typeof ImporterInput>;

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

export interface Country {
  code: string;
  name: string;
}

export type ClientDetail = { id: string } & { [K in keyof ClientInput]: ClientInput[K] | null } & {
  updatedAt: string;
};
export interface ClientSummary {
  id: string;
  legalName: string;
  countryCode: string;
  city: string;
  installationCount: number;
}
export type InstallationDetail = { id: string; clientId: string } & {
  [K in keyof InstallationInput]: InstallationInput[K] | null;
} & { updatedAt: string };
export type ImporterDetail = { id: string; clientId: string } & {
  [K in keyof ImporterInput]: ImporterInput[K] | null;
};

export interface TeamMember {
  userId: string;
  displayName: string;
  email: string;
  role: import('./enums').UserRole;
  /** null = client-level assignment; otherwise the installation. */
  installationId: string | null;
}

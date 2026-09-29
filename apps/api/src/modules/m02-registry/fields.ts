/**
 * API field ↔ database column maps. One place, so create, patch and read stay in step.
 */
export const CLIENT_COLUMNS = {
  legalName: 'legal_name',
  registrationNo: 'registration_no',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  postcode: 'postcode',
  city: 'city',
  countryCode: 'country_code',
  contactName: 'contact_name',
  contactEmail: 'contact_email',
  contactPhone: 'contact_phone',
} as const;

export const INSTALLATION_COLUMNS = {
  nameLocal: 'name_local',
  nameEn: 'name_en',
  street: 'street',
  economicActivity: 'economic_activity',
  postcode: 'postcode',
  poBox: 'po_box',
  city: 'city',
  countryCode: 'country_code',
  unLocode: 'un_locode',
  latitude: 'latitude',
  longitude: 'longitude',
  authRepName: 'auth_rep_name',
  authRepEmail: 'auth_rep_email',
  authRepPhone: 'auth_rep_phone',
  permitNo: 'permit_no',
} as const;

export const IMPORTER_COLUMNS = {
  name: 'name',
  eori: 'eori',
  addressLine1: 'address_line1',
  postcode: 'postcode',
  city: 'city',
  countryCode: 'country_code',
  contactName: 'contact_name',
  contactEmail: 'contact_email',
} as const;

type ColumnMap = Record<string, string>;

/** API object → row, only for keys present (so PATCH touches only what was sent). */
export function toRow(input: Record<string, unknown>, map: ColumnMap): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(map)) {
    if (field in input && input[field] !== undefined) row[column] = input[field];
  }
  return row;
}

/** Row → API object with every mapped field (null when empty). */
export function fromRow(row: Record<string, unknown>, map: ColumnMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(map)) {
    const v = row[column];
    out[field] = v === undefined ? null : typeof v === 'string' ? v.trimEnd() : v; // char(n) pads
  }
  return out;
}

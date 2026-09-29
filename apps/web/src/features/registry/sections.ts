import type { SectionDef } from '@/components/RecordForm';

// Field order and labels follow template sheet A (docs/mappings/template-A_InstData.md).

export const CLIENT_SECTIONS: SectionDef[] = [
  {
    title: 'Operator',
    description: 'The company that operates the installations. Not part of the EU template; used in reports.',
    fields: [
      { name: 'legalName', label: 'Legal name', required: true, wide: true },
      { name: 'registrationNo', label: 'Registration number' },
      { name: 'countryCode', label: 'Country', kind: 'country', required: true },
      { name: 'addressLine1', label: 'Address', required: true, wide: true },
      { name: 'addressLine2', label: 'Address line 2', wide: true },
      { name: 'postcode', label: 'Post code' },
      { name: 'city', label: 'City', required: true },
    ],
  },
  {
    title: 'Contact person',
    fields: [
      { name: 'contactName', label: 'Name', required: true, wide: true },
      { name: 'contactEmail', label: 'Email', kind: 'email', required: true },
      { name: 'contactPhone', label: 'Telephone', kind: 'tel' },
    ],
  },
];

export const INSTALLATION_SECTIONS: SectionDef[] = [
  {
    title: 'Installation',
    fields: [
      { name: 'nameEn', label: 'Name (English)', required: true, wide: true },
      { name: 'nameLocal', label: 'Name (local language)', wide: true },
      { name: 'economicActivity', label: 'Economic activity', wide: true },
      { name: 'permitNo', label: 'Installation ID or permit number', hint: 'Local registry ID. Not part of the EU template.' },
    ],
  },
  {
    title: 'Location',
    fields: [
      { name: 'street', label: 'Street and number', required: true, wide: true },
      { name: 'poBox', label: 'P.O. box' },
      { name: 'postcode', label: 'Post code' },
      { name: 'city', label: 'City', required: true },
      { name: 'countryCode', label: 'Country', kind: 'country', required: true },
      { name: 'unLocode', label: 'UN/LOCODE', hint: '5 characters, starting with the country code, e.g. INJGA.' },
      { name: 'latitude', label: 'Latitude of main emission source', kind: 'coordinate', unit: '°', hint: 'Decimal degrees, north positive, e.g. 22.470000.' },
      { name: 'longitude', label: 'Longitude of main emission source', kind: 'coordinate', unit: '°', hint: 'Decimal degrees, east positive, e.g. 70.057700.' },
    ],
  },
  {
    title: 'Authorised representative',
    fields: [
      { name: 'authRepName', label: 'Name', wide: true },
      { name: 'authRepEmail', label: 'Email', kind: 'email' },
      { name: 'authRepPhone', label: 'Telephone', kind: 'tel' },
    ],
  },
];

export const IMPORTER_SECTIONS: SectionDef[] = [
  {
    title: 'EU importer',
    fields: [
      { name: 'name', label: 'Name', required: true, wide: true },
      { name: 'eori', label: 'EORI number', required: true },
      { name: 'countryCode', label: 'Country', kind: 'country' },
      { name: 'addressLine1', label: 'Address', wide: true },
      { name: 'postcode', label: 'Post code' },
      { name: 'city', label: 'City' },
      { name: 'contactName', label: 'Contact name' },
      { name: 'contactEmail', label: 'Contact email', kind: 'email' },
    ],
  },
];

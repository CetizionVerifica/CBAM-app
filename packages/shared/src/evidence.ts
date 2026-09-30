import { z } from 'zod';
import { optionalText, requiredText } from './fields';
import { IsoDate } from './library';
import { CountryCode } from './registry';

/**
 * M13 — evidence, verification and the audit trail. Shared by API and forms (G8).
 */

// ---------------------------------------------------------------------------
// Files (M13-R3, design system 5.9)
// ---------------------------------------------------------------------------

export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

/** Accepted files: extension → content type. The API also checks the file's own bytes. */
export const EVIDENCE_FILE_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
} as const;
export type EvidenceContentType = (typeof EVIDENCE_FILE_TYPES)[keyof typeof EVIDENCE_FILE_TYPES];

export const EVIDENCE_ACCEPT = Object.keys(EVIDENCE_FILE_TYPES).map((e) => `.${e}`).join(',');

/** Why a file is refused before upload, in the words the UI shows; null when it is fine. */
export function evidenceFileProblem(name: string, bytes: number): string | null {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!(ext in EVIDENCE_FILE_TYPES)) return 'Only PDF, PNG, JPEG, XLSX and CSV files are accepted.';
  if (bytes === 0) return 'This file is empty.';
  if (bytes > EVIDENCE_MAX_BYTES) return 'Files over 25 MB aren’t accepted. Split or compress the file.';
  return null;
}

export const EVIDENCE_DOC_TYPES = ['invoice', 'meter_reading', 'lab_report', 'contract', 'certificate', 'photo', 'other'] as const;
export const EvidenceDocType = z.enum(EVIDENCE_DOC_TYPES);
export type EvidenceDocType = z.infer<typeof EvidenceDocType>;

export const EVIDENCE_DOC_TYPE_LABELS: Record<EvidenceDocType, string> = {
  invoice: 'Invoice',
  meter_reading: 'Meter reading',
  lab_report: 'Lab report',
  contract: 'Contract',
  certificate: 'Certificate',
  photo: 'Photo',
  other: 'Other',
};

/** Records evidence can support now; later modules add theirs (and to app.evidence_linkable). */
export const EVIDENCE_RECORD_TYPES = [
  'client', 'installation', 'eu_importer', 'client_factor_override', 'period_version', 'verification',
  'production_process', 'process_good',
] as const;
export const EvidenceRecordType = z.enum(EVIDENCE_RECORD_TYPES);
export type EvidenceRecordType = z.infer<typeof EvidenceRecordType>;

export const EvidenceRecordRef = z.object({ recordType: EvidenceRecordType, recordId: z.uuid() });
export type EvidenceRecordRef = z.infer<typeof EvidenceRecordRef>;

/** Upload metadata, sent as query parameters next to the raw file body. */
export const EvidenceUploadQuery = z
  .object({
    fileName: requiredText(255, 'The file needs a name.'),
    docType: EvidenceDocType,
    title: optionalText(300),
    documentDate: z.union([z.literal(''), IsoDate]).transform((v) => (v === '' ? null : v)).nullable().optional(),
    installationId: z.union([z.literal(''), z.uuid()]).transform((v) => (v === '' ? null : v)).nullable().optional(),
    recordType: EvidenceRecordType.optional(),
    recordId: z.uuid().optional(),
  })
  .refine((v) => (v.recordType === undefined) === (v.recordId === undefined), 'Give both the record type and the record id, or neither.');
export type EvidenceUploadQuery = z.infer<typeof EvidenceUploadQuery>;

export const EvidencePatch = z
  .object({
    title: requiredText(300, 'Enter a title.').optional(),
    docType: EvidenceDocType.optional(),
    documentDate: z.union([z.literal(''), IsoDate]).transform((v) => (v === '' ? null : v)).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field.');

export interface EvidenceLinkSummary {
  id: string;
  recordType: EvidenceRecordType;
  recordId: string;
  /** Who made the link: contributors remove only their own (review M13 F3). */
  createdById: string;
  /** Human label, e.g. "Installation: Jamnagar smelter"; null when the caller cannot see the record. */
  label: string | null;
  /** Links to an approved or issued period cannot be removed (M13-R4). */
  locked: boolean;
}

export interface EvidenceSummary {
  id: string;
  clientId: string;
  installationId: string | null;
  title: string;
  docType: EvidenceDocType;
  documentDate: string | null;
  fileName: string;
  contentType: EvidenceContentType;
  bytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedById: string;
  uploadedBy: string | null;
  links: EvidenceLinkSummary[];
  /** Supports an approved or issued period: cannot be changed or deleted (M13-R4). */
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Verification (M13-R7). Field → template cell: docs/mappings/template-A_InstData.md I37–I53.
// ---------------------------------------------------------------------------

const Email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);

export const VerificationFields = z.object({
  verifierName: optionalText(300),
  verifierStreet: optionalText(300),
  verifierCity: optionalText(200),
  verifierPostcode: optionalText(40),
  verifierCountryCode: z.union([z.literal(''), CountryCode]).transform((v) => (v === '' ? null : v)).nullable().optional(),
  repName: optionalText(200),
  repEmail: z.union([z.literal(''), Email]).transform((v) => (v === '' ? null : v)).nullable().optional(),
  repPhone: optionalText(50),
  repFax: optionalText(50),
  accreditationMemberState: z.union([z.literal(''), CountryCode]).transform((v) => (v === '' ? null : v)).nullable().optional(),
  accreditationBody: optionalText(300),
  accreditationRegNo: optionalText(100),
  siteVisitDate: z.union([z.literal(''), IsoDate]).transform((v) => (v === '' ? null : v)).nullable().optional(),
  opinion: optionalText(10000),
  findings: z
    .array(z.string().trim().min(1, 'A finding cannot be empty.').max(2000, 'Use at most 2000 characters.'))
    .max(200, 'Use at most 200 findings.')
    .optional(),
});
export const VerificationInput = VerificationFields.refine((v) => Object.keys(v).length > 0, 'Change at least one field.');
export type VerificationInput = z.infer<typeof VerificationFields>;

export const VerificationApproval = z.object({
  kind: z.enum(['consultant', 'client']),
  approved: z.boolean(),
});

export interface VerificationDetail extends Required<{ [K in keyof VerificationInput]: Exclude<VerificationInput[K], undefined> }> {
  id: string | null;
  periodVersionId: string;
  consultantApproval: { at: string; by: string | null } | null;
  clientApproval: { at: string; by: string | null } | null;
}

// ---------------------------------------------------------------------------
// Audit trail (M13-R5, R6)
// ---------------------------------------------------------------------------

/** Tables per module, for the "module" filter of the audit trail. */
export const AUDIT_MODULES = {
  M1: ['public.tenant', 'public.app_user', 'public.user_client_assignment', 'public.user_installation_assignment', 'public.invitation'],
  M2: ['public.client', 'public.installation', 'public.eu_importer'],
  M3: ['public.reporting_period', 'public.period_version', 'public.period_status_change'],
  M4: [
    'public.library_version', 'public.goods_category', 'public.production_route', 'public.route_relevant_precursor',
    'public.qualifying_parameter_def', 'public.cn_code', 'public.library_factor', 'public.template_version',
    'public.library_import', 'public.client_factor_override', 'public.library_setting',
  ],
  M5: [
    'public.production_process', 'public.process_included_category', 'public.process_route', 'public.process_good',
    'public.process_good_parameter', 'public.process_internal_use',
  ],
  M13: ['public.evidence_document', 'public.evidence_link', 'public.verification'],
} as const;
export type AuditModule = keyof typeof AUDIT_MODULES;

export const AUDIT_MODULE_LABELS: Record<AuditModule, string> = {
  M1: 'Users and access',
  M2: 'Clients and installations',
  M3: 'Reporting periods',
  M4: 'Reference library',
  M5: 'Processes and goods',
  M13: 'Evidence and verification',
};

export const AuditQuery = z.object({
  clientId: z.uuid().optional(),
  userId: z.uuid().optional(),
  module: z.enum(Object.keys(AUDIT_MODULES) as [AuditModule, ...AuditModule[]]).optional(),
  table: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional(),
  recordId: z.string().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** Keyset cursor: entries with a smaller id than this. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export interface AuditChange {
  field: string;
  old: unknown;
  new: unknown;
}

export interface AuditEntry {
  id: number;
  occurredAt: string;
  actorId: string;
  actorName: string | null;
  actorRole: string | null;
  action: string | null;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  recordId: string | null;
  clientId: string | null;
  reason: string | null;
  changes: AuditChange[];
}


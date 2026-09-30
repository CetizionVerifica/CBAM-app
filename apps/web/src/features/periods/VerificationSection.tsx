import { type VerificationDetail, VerificationFields, can } from '@cbam/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/Button';
import { RecordForm, type SectionDef, toFormValues } from '@/components/RecordForm';
import { ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { ApiError, api } from '@/lib/api';
import { formatMoment } from '@/lib/format';
import { useMe } from '@/lib/session';

// Template sheet A section 3 (I37–I53), then what the spec adds (4.10).
const SECTIONS: SectionDef[] = [
  {
    title: 'Verifier',
    description: 'Template sheet A, section 3. Leave empty if the report is not verified.',
    fields: [
      { name: 'verifierName', label: 'Company name', wide: true },
      { name: 'verifierStreet', label: 'Street and number', wide: true },
      { name: 'verifierCity', label: 'City' },
      { name: 'verifierPostcode', label: 'Post code' },
      { name: 'verifierCountryCode', label: 'Country', kind: 'country' },
    ],
  },
  {
    title: 'Verifier’s authorised representative',
    description: 'Ideally the lead verifier for this report.',
    fields: [
      { name: 'repName', label: 'Name', wide: true },
      { name: 'repEmail', label: 'Email', kind: 'email' },
      { name: 'repPhone', label: 'Telephone', kind: 'tel' },
      { name: 'repFax', label: 'Fax', kind: 'tel' },
    ],
  },
  {
    title: 'Accreditation',
    fields: [
      { name: 'accreditationMemberState', label: 'Accreditation member state', kind: 'country' },
      { name: 'accreditationBody', label: 'National accreditation body' },
      { name: 'accreditationRegNo', label: 'Registration number' },
    ],
  },
  {
    title: 'Verification',
    fields: [
      { name: 'siteVisitDate', label: 'Site visit date', kind: 'date' },
      { name: 'opinion', label: 'Verification opinion', kind: 'textarea', wide: true },
      { name: 'findings', label: 'Findings', kind: 'textarea', wide: true, hint: 'One finding per line.' },
    ],
  },
];

// The form edits findings as text, one per line; the API takes a list.
const FormSchema = VerificationFields.omit({ findings: true }).extend({ findings: z.string().max(200 * 2000).optional() });
const toFindings = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** Verifier details, opinion and approvals for one period version (M13-R7). */
export function VerificationSection({ versionId, locked }: { versionId: string; locked: boolean }) {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['verification', versionId];
  const verification = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<{ verification: VerificationDetail }>(`/period-versions/${versionId}/verification`)).verification,
  });
  const [error, setError] = useState<string | null>(null);
  const role = me.user.role;

  if (verification.isPending) return <SkeletonRows rows={4} />;
  if (verification.isError) return <ErrorState message={verification.error.message} />;
  const v = verification.data;

  const approve = async (kind: 'consultant' | 'client', approved: boolean) => {
    setError(null);
    try {
      const { verification: next } = await api.post<{ verification: VerificationDetail }>(
        `/period-versions/${versionId}/verification/approvals`,
        { kind, approved },
      );
      qc.setQueryData(key, next);
      toast(approved ? 'Verification approved' : 'Approval withdrawn');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  const approvalRow = (kind: 'consultant' | 'client', label: string, value: VerificationDetail['consultantApproval'], allowed: boolean) => (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-40 text-body text-ink-muted">{label}</span>
      {value ? (
        <span className="flex items-center gap-2 text-body text-ink">
          <CheckCircle2 aria-hidden className="size-4 text-ok" strokeWidth={1.5} />
          Approved by {value.by ?? 'a user you cannot see'}, <span className="tabular-nums">{formatMoment(value.at)}</span>
        </span>
      ) : (
        <span className="text-body text-ink-muted">Not approved</span>
      )}
      {allowed && !locked && v.id && (
        <Button variant={value ? 'quiet' : 'secondary'} onClick={() => approve(kind, !value)}>
          {value ? 'Withdraw approval' : 'Approve verification'}
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex max-w-[880px] flex-col gap-2 rounded-panel border border-rule bg-surface p-4">
        <h3 className="text-h3 font-semibold text-ink">Approvals</h3>
        <p className="text-small text-ink-muted">Changing any verification detail withdraws both approvals.</p>
        {approvalRow('consultant', 'Consultant', v.consultantApproval, can(role, 'verification.approveConsultant'))}
        {approvalRow('client', 'Client', v.clientApproval, can(role, 'verification.approveClient'))}
        {!v.id && <p className="text-small text-ink-muted">Enter the verification details before approving them.</p>}
        {error && <ErrorState message={error} />}
      </div>
      <RecordForm
        mode="edit"
        readOnly={locked || !can(role, 'verification.edit')}
        sections={SECTIONS}
        schema={FormSchema as never}
        values={{ ...toFormValues(v as unknown as Record<string, unknown>, SECTIONS), findings: v.findings.join('\n') }}
        onSave={async (patch) => {
          const body = { ...patch, ...(patch.findings !== undefined && { findings: toFindings(patch.findings) }) };
          const { verification: next } = await api.put<{ verification: VerificationDetail }>(`/period-versions/${versionId}/verification`, body);
          qc.setQueryData(key, next);
        }}
      />
    </div>
  );
}

import {
  EVIDENCE_ACCEPT,
  EVIDENCE_DOC_TYPES,
  EVIDENCE_DOC_TYPE_LABELS,
  type EvidenceDocType,
  type EvidenceRecordRef,
  type EvidenceSummary,
  evidenceFileProblem,
} from '@cbam/shared';
import { Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { SelectField } from '@/components/Field';
import { ErrorState } from '@/components/States';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Evidence drop zone (design system 5.9): drag files here or choose them. Files are checked
 * before upload with the same rules the API applies (type, 25 MB), and the API then checks
 * the bytes. Each file is uploaded on its own, so one refused file does not stop the rest.
 */
export function EvidenceUpload({
  clientId,
  installationId,
  record,
  installations,
  installationRequired = false,
  onUploaded,
}: {
  clientId: string;
  installationId?: string | null;
  /** Link each upload to this record. */
  record?: EvidenceRecordRef;
  /** Offer a choice of installation to file the upload under (evidence library). */
  installations?: { id: string; name: string }[];
  /** Contributors must file uploads under one of their installations (D4). */
  installationRequired?: boolean;
  onUploaded: (evidence: EvidenceSummary) => void;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<EvidenceDocType>('other');
  const [site, setSite] = useState(installations?.length === 1 && installationRequired ? installations[0]!.id : '');
  const siteMissing = !!installations && installationRequired && !site;
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const send = async (files: File[]) => {
    if (siteMissing) {
      setProblems(['Choose the installation this file belongs to.']);
      return;
    }
    const found: string[] = [];
    for (const file of files) {
      const problem = evidenceFileProblem(file.name, file.size);
      if (problem) {
        found.push(`${file.name}: ${problem}`);
        continue;
      }
      setBusy(file.name);
      try {
        const { evidence } = await api.upload<{ evidence: EvidenceSummary }>(`/clients/${clientId}/evidence`, file, {
          fileName: file.name,
          docType,
          installationId: installationId ?? (site || undefined),
          recordType: record?.recordType,
          recordId: record?.recordId,
        });
        onUploaded(evidence);
      } catch (e) {
        found.push(`${file.name}: ${e instanceof ApiError ? e.message : 'Something went wrong. Try again.'}`);
      }
    }
    setBusy(null);
    setProblems(found);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <SelectField
            label="Type of evidence"
            value={docType}
            onChange={(e) => setDocType(e.target.value as EvidenceDocType)}
            options={EVIDENCE_DOC_TYPES.map((t) => ({ value: t, label: EVIDENCE_DOC_TYPE_LABELS[t] }))}
          />
        </div>
        {installations && (
          <div className="w-64">
            <SelectField
              label="Installation"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              options={[
                { value: '', label: installationRequired ? 'Choose an installation…' : 'Whole client (no installation)' },
                ...installations.map((i) => ({ value: i.id, label: i.name })),
              ]}
            />
          </div>
        )}
      </div>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void send([...e.dataTransfer.files]);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-panel border border-dashed border-rule-strong bg-surface p-6 text-center',
          'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action',
          dragging && 'border-action bg-action-tint',
        )}
      >
        <Upload aria-hidden className="size-5 text-ink-muted" strokeWidth={1.5} />
        <span className="text-body text-ink">
          {busy ? `Uploading ${busy}…` : (
            <>
              Drop files here or <span className="font-semibold text-action underline">choose files</span>
            </>
          )}
        </span>
        <span className="text-small text-ink-muted">
          {siteMissing ? 'Choose the installation first.' : 'PDF, PNG, JPEG, XLSX or CSV, up to 25 MB each.'}
        </span>
        <input
          ref={input}
          id={inputId}
          type="file"
          multiple
          accept={EVIDENCE_ACCEPT}
          className="sr-only"
          disabled={!!busy || siteMissing}
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            if (input.current) input.current.value = '';
          }}
        />
      </label>
      {problems.length > 0 && (
        <ErrorState
          message={problems.length === 1 ? problems[0]! : `${problems.length} files were not uploaded. ${problems.join(' ')}`}
        />
      )}
    </div>
  );
}

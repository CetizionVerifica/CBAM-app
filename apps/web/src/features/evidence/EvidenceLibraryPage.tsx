import {
  EVIDENCE_DOC_TYPES,
  EVIDENCE_DOC_TYPE_LABELS,
  EVIDENCE_RECORD_TYPES,
  type EvidenceDocType,
  type EvidenceRecordType,
  type EvidenceSummary,
  can,
} from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Lock } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Field, SelectField } from '@/components/Field';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useClient, useClients } from '@/features/registry/queries';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoment } from '@/lib/format';
import { useMe } from '@/lib/session';
import { EvidenceUpload } from './EvidenceUpload';
import { downloadEvidence, evidenceKeys, formatBytes, useClientEvidence } from './queries';

const RECORD_LABELS: Record<EvidenceRecordType, string> = {
  client: 'Client',
  installation: 'Installation',
  eu_importer: 'EU importer',
  client_factor_override: 'Factor override',
  period_version: 'Reporting period',
  verification: 'Verification',
};

/** Evidence library (design system 6.11): files of one client, filters, and a detail pane. */
export function EvidenceLibraryPage() {
  const me = useMe().data!;
  const [search, setSearch] = useSearchParams();
  const clients = useClients();
  const clientId = search.get('client') ?? clients.data?.[0]?.id ?? '';
  const openId = search.get('open');
  const evidence = useClientEvidence(clientId);
  const client = useClient(clientId);
  const [docType, setDocType] = useState<'' | EvidenceDocType>('');
  const [recordType, setRecordType] = useState<'' | EvidenceRecordType>('');
  const [uploading, setUploading] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const set = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(search);
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    setSearch(p, { replace: true });
  };

  const rows = (evidence.data ?? []).filter(
    (e) => (!docType || e.docType === docType) && (!recordType || e.links.some((l) => l.recordType === recordType)),
  );
  const open = evidence.data?.find((e) => e.id === openId) ?? null;

  if (clients.isPending) return <div className="p-6"><SkeletonRows rows={6} /></div>;
  if (clients.isError) return <div className="p-6"><ErrorState message={clients.error.message} /></div>;

  return (
    <div className="p-6">
      <PageHeader
        title="Evidence"
        description="Invoices, meter readings, lab reports and other files that support the data. One file can support several records."
        actions={can(me.user.role, 'evidence.upload') && clientId ? <Button variant="primary" onClick={() => setUploading((u) => !u)}>{uploading ? 'Close upload' : 'Upload evidence'}</Button> : undefined}
      />
      {clients.data.length === 0 ? (
        <EmptyState message="No clients yet. Evidence belongs to a client, so add a client first." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="w-64">
              <SelectField
                label="Client"
                value={clientId}
                onChange={(e) => set({ client: e.target.value, open: null })}
                options={clients.data.map((c) => ({ value: c.id, label: c.legalName }))}
              />
            </div>
            <div className="w-48">
              <SelectField
                label="Type"
                value={docType}
                onChange={(e) => setDocType(e.target.value as '' | EvidenceDocType)}
                options={[{ value: '', label: 'All types' }, ...EVIDENCE_DOC_TYPES.map((t) => ({ value: t, label: EVIDENCE_DOC_TYPE_LABELS[t] }))]}
              />
            </div>
            <div className="w-48">
              <SelectField
                label="Supports"
                value={recordType}
                onChange={(e) => setRecordType(e.target.value as '' | EvidenceRecordType)}
                options={[{ value: '', label: 'Any record' }, ...EVIDENCE_RECORD_TYPES.map((t) => ({ value: t, label: RECORD_LABELS[t] }))]}
              />
            </div>
          </div>

          {uploading && (
            <div className="mb-6 max-w-[880px]">
              <EvidenceUpload
                clientId={clientId}
                installations={(client.data?.installations ?? []).map((i) => ({ id: i.id, name: i.nameEn ?? '' }))}
                installationRequired={me.user.role === 'contributor'}
                onUploaded={(ev) => {
                  void qc.invalidateQueries({ queryKey: evidenceKeys.all });
                  toast('Evidence uploaded');
                  set({ open: ev.id });
                }}
              />
            </div>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1279px]:grid-cols-1">
            <div>
              {evidence.isPending ? (
                <SkeletonRows rows={6} />
              ) : evidence.isError ? (
                <ErrorState message={evidence.error.message} actions={<Button onClick={() => evidence.refetch()}>Try again</Button>} />
              ) : rows.length === 0 ? (
                <EmptyState
                  message={
                    evidence.data.length === 0
                      ? 'No evidence for this client yet. Upload the files that support its data.'
                      : 'No evidence matches these filters.'
                  }
                />
              ) : (
                <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
                  <table className="w-full text-left text-small">
                    <thead className="bg-surface-sunken text-ink">
                      <tr>
                        {['Title', 'Type', 'Supports', 'Uploaded', 'Size'].map((h) => (
                          <th key={h} scope="col" className={cn('h-8 border-b border-rule px-3 font-semibold', h === 'Size' && 'text-right')}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((e) => (
                        <tr key={e.id} className={cn('border-b border-rule last:border-b-0 hover:bg-action-tint', e.id === openId && 'bg-action-tint')}>
                          <td className="px-3 py-2 font-semibold">
                            <button type="button" className="text-left text-ink hover:underline" onClick={() => set({ open: e.id })}>
                              {e.locked && <Lock aria-label="Locked" className="mr-1 inline size-3.5 text-locked" strokeWidth={1.5} />}
                              {e.title}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-ink">{EVIDENCE_DOC_TYPE_LABELS[e.docType]}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {e.links.length === 0 ? <span className="text-ink-muted">—</span> : e.links.map((l) => (
                                <span key={l.id} className="rounded-input bg-surface-sunken px-2 py-0.5 text-caption text-ink">{l.label ?? RECORD_LABELS[l.recordType]}</span>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-ink">
                            <span className="tabular-nums">{formatMoment(e.uploadedAt)}</span>
                            {e.uploadedBy && <span className="block text-ink-muted">{e.uploadedBy}</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink">{formatBytes(e.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {open && <EvidenceDetail key={open.id} evidence={open} onClose={() => set({ open: null })} />}
          </div>
        </>
      )}
    </div>
  );
}

/** The detail pane: metadata, linked records, download, edit and delete (M13-R4 aware). */
function EvidenceDetail({ evidence: ev, onClose }: { evidence: EvidenceSummary; onClose: () => void }) {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(ev.title);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const mine = me.user.role === 'contributor' && ev.uploadedById === me.user.id;
  const canEdit = !ev.locked && (can(me.user.role, 'evidence.manage') || mine);

  const save = async (patch: Record<string, string | null>) => {
    setError(null);
    try {
      await api.patch(`/evidence/${ev.id}`, patch);
      void qc.invalidateQueries({ queryKey: evidenceKeys.all });
      toast('Evidence saved');
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'Something went wrong. Try again.');
    }
  };

  return (
    <aside aria-label="Evidence details" className="flex flex-col gap-4 self-start rounded-panel border border-rule bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-h3 font-semibold text-ink">{ev.title}</h2>
        <Button variant="quiet" onClick={onClose}>Close</Button>
      </div>
      {ev.locked && (
        <p className="flex items-center gap-2 text-small text-ink">
          <Lock aria-hidden className="size-4 text-locked" strokeWidth={1.5} />
          Supports an approved or issued period, so it cannot be changed or deleted.
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-small">
        <dt className="text-ink-muted">File</dt>
        <dd className="break-all text-ink">{ev.fileName}</dd>
        <dt className="text-ink-muted">Size</dt>
        <dd className="tabular-nums text-ink">{formatBytes(ev.bytes)}</dd>
        <dt className="text-ink-muted">Uploaded</dt>
        <dd className="text-ink">
          <span className="tabular-nums">{formatMoment(ev.uploadedAt)}</span>
          {ev.uploadedBy && `, ${ev.uploadedBy}`}
        </dd>
        {ev.documentDate && (
          <>
            <dt className="text-ink-muted">Document date</dt>
            <dd className="tabular-nums text-ink">{formatDate(ev.documentDate)}</dd>
          </>
        )}
        <dt className="text-ink-muted">SHA-256</dt>
        <dd className="break-all font-mono text-caption text-ink">{ev.sha256}</dd>
      </dl>
      <Button onClick={() => downloadEvidence(ev.id).catch((e) => setError(e instanceof ApiError ? e.message : 'Download failed. Try again.'))}>
        <Download aria-hidden className="size-4" strokeWidth={1.5} /> Download
      </Button>

      <div>
        <h3 className="mb-2 text-body font-semibold text-ink">Supports</h3>
        {ev.links.length === 0 ? (
          <p className="text-small text-ink-muted">Not linked to any record yet. On the record’s screen, choose Add evidence, then Link existing evidence.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-small text-ink">
            {ev.links.map((l) => (
              <li key={l.id} className="flex items-center gap-1">
                {l.locked && <Lock aria-label="Locked" className="size-3.5 text-locked" strokeWidth={1.5} />}
                {l.label ?? `${RECORD_LABELS[l.recordType]} you cannot see`}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-col gap-3 border-t border-rule pt-4">
          <Field label="Title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== ev.title && save({ title })} />
          <SelectField
            label="Type"
            value={ev.docType}
            onChange={(e) => save({ docType: e.target.value })}
            options={EVIDENCE_DOC_TYPES.map((t) => ({ value: t, label: EVIDENCE_DOC_TYPE_LABELS[t] }))}
          />
          <Field label="Document date" type="date" defaultValue={ev.documentDate ?? ''} onBlur={(e) => e.target.value !== (ev.documentDate ?? '') && save({ documentDate: e.target.value })} />
          <Button variant="destructive" className="self-start" onClick={() => setDeleting(true)}>Delete evidence</Button>
        </div>
      )}
      {error && <ErrorState message={error} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${ev.title}?`}
          consequence="The file disappears from the evidence library and from every record it supports. It stays in storage and in the audit trail."
          confirmLabel="Delete evidence"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.delete(`/evidence/${ev.id}`);
            void qc.invalidateQueries({ queryKey: evidenceKeys.all });
            toast('Evidence deleted');
            onClose();
          }}
        />
      )}
    </aside>
  );
}

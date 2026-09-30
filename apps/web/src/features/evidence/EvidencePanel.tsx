import { EVIDENCE_DOC_TYPE_LABELS, type EvidenceRecordType, type EvidenceSummary, can } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/Button';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { ApiError, api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useMe } from '@/lib/session';
import { EvidenceUpload } from './EvidenceUpload';
import { downloadEvidence, evidenceKeys, formatBytes, useRecordEvidence } from './queries';

/**
 * Evidence supporting one record (M13-R1), for the record's own screen: list, download,
 * upload-and-link, and remove the link. Locked periods show the files read-only (M13-R4).
 */
export function EvidencePanel({
  clientId,
  installationId,
  recordType,
  recordId,
  locked = false,
}: {
  clientId: string;
  installationId?: string | null;
  recordType: EvidenceRecordType;
  recordId: string;
  locked?: boolean;
}) {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const evidence = useRecordEvidence(recordType, recordId);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const canUpload = can(me.user.role, 'evidence.upload') && !locked;
  if (!can(me.user.role, 'evidence.read')) return null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: evidenceKeys.all });
  };

  const unlink = async (ev: EvidenceSummary) => {
    const link = ev.links.find((l) => l.recordType === recordType && l.recordId === recordId);
    if (!link) return;
    setError(null);
    try {
      await api.delete(`/evidence/${ev.id}/links/${link.id}`);
      refresh();
      toast('Evidence unlinked');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-h2 font-semibold text-ink">Evidence</h2>
        {canUpload && evidence.data && evidence.data.length > 0 && (
          <Button onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'Add evidence'}</Button>
        )}
      </div>
      {locked && (
        <p className="mb-3 flex items-center gap-2 text-small text-ink-muted">
          <Lock aria-hidden className="size-4 text-locked" strokeWidth={1.5} />
          This period is read-only, so its evidence cannot change.
        </p>
      )}
      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}
      {evidence.isPending ? (
        <SkeletonRows rows={2} />
      ) : evidence.isError ? (
        <ErrorState message={evidence.error.message} actions={<Button onClick={() => evidence.refetch()}>Try again</Button>} />
      ) : (
        <>
          {evidence.data.length === 0 && !canUpload && <EmptyState message="No evidence is attached to this record." />}
          {evidence.data.length > 0 && (
            <ul className="flex flex-col rounded-panel border border-rule bg-surface">
              {evidence.data.map((ev) => (
                <li key={ev.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-4 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <Link to={`/evidence?client=${clientId}&open=${ev.id}`} className="font-semibold text-ink hover:underline">
                      {ev.title}
                    </Link>
                    <p className="text-small text-ink-muted">
                      {EVIDENCE_DOC_TYPE_LABELS[ev.docType]} · {ev.fileName} · <span className="tabular-nums">{formatBytes(ev.bytes)}</span>
                      {ev.documentDate && <> · <span className="tabular-nums">{formatDate(ev.documentDate)}</span></>}
                      {ev.uploadedBy && <> · uploaded by {ev.uploadedBy}</>}
                      {ev.links.length > 1 && <> · supports {ev.links.length} records</>}
                    </p>
                  </div>
                  <Button variant="quiet" onClick={() => downloadEvidence(ev.id).catch((e) => setError(e instanceof ApiError ? e.message : 'Download failed. Try again.'))}>
                    <Download aria-hidden className="size-4" strokeWidth={1.5} /> Download
                  </Button>
                  {canUpload && (
                    <Button variant="quiet" onClick={() => unlink(ev)}>
                      Unlink
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canUpload && (evidence.data.length === 0 || adding) && (
            <div className="mt-3">
              {evidence.data.length === 0 && (
                <p className="mb-3 text-body text-ink">No evidence yet. Attach the invoices, meter readings or reports that support this record.</p>
              )}
              <EvidenceUpload
                clientId={clientId}
                installationId={installationId}
                record={{ recordType, recordId }}
                onUploaded={() => {
                  refresh();
                  toast('Evidence uploaded');
                }}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

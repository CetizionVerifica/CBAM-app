import type { LibraryVersionSummary } from '@cbam/shared';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field } from '@/components/Field';
import { ErrorState, SkeletonRows } from '@/components/States';
import { ApiError, api } from '@/lib/api';
import { LibraryDiffView } from './DiffView';
import { useVersionDiff } from './queries';

/**
 * Publishing is wide-impact and irreversible (design system 7): the dialog shows the diff,
 * says who uses the new version and that issued periods are unaffected, and asks for the
 * version code to be typed back.
 */
export function PublishDialog({ version, onClose, onPublished }: { version: LibraryVersionSummary; onClose: () => void; onPublished: () => void }) {
  const diff = useVersionDiff(version.id, true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/library/versions/${version.id}/publish`, { confirmCode: code, diffFingerprint: diff.data!.fingerprint });
      onPublished();
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'Something went wrong. Try again.');
      if (e instanceof ApiError && e.code === 'stale_diff') void diff.refetch();
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Publish library version ${version.code}?`}
      description={`Periods opened from now on use ${version.code}. Periods already open, approved or issued keep the version they pinned, so their results do not change. A published version can never be edited.`}
    >
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        <h3 className="text-h3 font-semibold text-ink">Changes from {version.basedOnCode ?? 'an empty library'}</h3>
        {diff.isPending ? <SkeletonRows rows={4} /> : diff.isError ? <ErrorState message={diff.error.message} /> : <LibraryDiffView diff={diff.data.diff} />}
        <Field label={`Type ${version.code} to confirm`} value={code} autoComplete="off" onChange={(e) => setCode(e.target.value)} />
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !diff.data || code.trim() !== version.code} onClick={publish}>
            Publish version
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { ErrorState } from './States';

/** Confirmation for irreversible or wide-impact actions; states the consequence (design system 7). */
export function ConfirmDialog({
  title,
  consequence,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  consequence: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={consequence}>
      <div className="flex flex-col gap-4">
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="confirmDestructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

import { type ImporterDetail, ImporterInput } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Dialog } from '@/components/Dialog';
import { RecordForm, toFormValues } from '@/components/RecordForm';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { useCountryName } from '@/lib/reference';
import { keys } from './queries';
import { IMPORTER_SECTIONS } from './sections';

/** EU importers served by the client, with EORI (design system 6.2). */
export function ImportersPanel({ clientId, importers, canWrite }: { clientId: string; importers: ImporterDetail[]; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const countryName = useCountryName();
  const [editing, setEditing] = useState<ImporterDetail | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ImporterDetail | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.client(clientId) });

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-h2 font-semibold text-ink">EU importers</h2>
        {canWrite && <Button onClick={() => setEditing('new')}>Add importer</Button>}
      </div>
      {importers.length === 0 ? (
        <p className="rounded-panel border border-rule bg-surface p-4 text-body text-ink-muted">
          No EU importers yet. Add the importers or customs representatives who receive this client’s data.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
          <table className="w-full text-left text-small">
            <thead className="bg-surface-sunken text-ink">
              <tr>
                {['Name', 'EORI', 'Country', 'Contact', ''].map((h, i) => (
                  <th key={i} scope="col" className="h-8 border-b border-rule px-3 font-semibold">
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {importers.map((imp) => (
                <tr key={imp.id} className="h-10 border-b border-rule last:border-b-0">
                  <td className="px-3 font-semibold text-ink">{imp.name}</td>
                  <td className="px-3 font-mono text-ink">{imp.eori}</td>
                  <td className="px-3 text-ink">{countryName(imp.countryCode)}</td>
                  <td className="px-3 text-ink">{imp.contactEmail ?? '—'}</td>
                  <td className="px-2 text-right whitespace-nowrap">
                    {canWrite && (
                      <>
                        <Button variant="quiet" onClick={() => setEditing(imp)}>Edit</Button>
                        <Button variant="destructive" onClick={() => setDeleting(imp)}>Delete</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add importer' : `Edit ${editing.name}`}>
          <div className="max-h-[70vh] overflow-y-auto">
            <RecordForm
              mode="create"
              sections={IMPORTER_SECTIONS}
              schema={ImporterInput as never}
              values={toFormValues(editing === 'new' ? undefined : editing, IMPORTER_SECTIONS)}
              submitLabel={editing === 'new' ? 'Add importer' : 'Save importer'}
              onCancel={() => setEditing(null)}
              onSubmit={async (values) => {
                if (editing === 'new') await api.post(`/clients/${clientId}/importers`, values);
                else await api.patch(`/importers/${editing.id}`, values);
                await refresh();
                toast(editing === 'new' ? 'Importer added' : 'Importer saved');
                setEditing(null);
              }}
            />
          </div>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          consequence="The importer no longer appears on this client or in new importer summaries. Its history stays in the audit trail."
          confirmLabel="Delete importer"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.delete(`/importers/${deleting.id}`);
            await refresh();
            toast('Importer deleted');
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

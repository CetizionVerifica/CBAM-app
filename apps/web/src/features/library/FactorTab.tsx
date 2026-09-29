import { FACTOR_KIND_LABELS, type FactorKind, type LibraryFactor, type LibraryVersionSummary } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Dialog } from '@/components/Dialog';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { formatExact, unitLabel } from '@/lib/format';
import { FactorForm, factorFormValues } from './FactorForm';
import { FACTOR_TABS, libraryKeys, useFactors } from './queries';

const th = 'h-8 border-b border-rule px-3 font-semibold whitespace-nowrap';

/** One factor kind in one version (M4-R1, R6, R8). Values are shown exactly as stored. */
export function FactorTab({ version, kind, editable }: { version: LibraryVersionSummary; kind: FactorKind; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const factors = useFactors(version.id);
  const [editing, setEditing] = useState<LibraryFactor | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LibraryFactor | null>(null);
  const tab = FACTOR_TABS.find((t) => t.kind === kind)!;
  const refresh = () => qc.invalidateQueries({ queryKey: libraryKeys.versions });

  if (factors.isPending) return <SkeletonRows rows={6} />;
  if (factors.isError) return <ErrorState message={factors.error.message} />;
  const rows = factors.data.filter((f) => f.kind === kind);
  const grid = kind === 'grid_factor';
  const see = kind === 'default_see';

  return (
    <>
      {editable && (
        <div className="mb-3 flex justify-end">
          <Button onClick={() => setEditing('new')}>Add {FACTOR_KIND_LABELS[kind].toLowerCase()}</Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState
          message={
            editable
              ? `No ${tab.empty} in draft ${version.code} yet. Import the official file or add them one by one.`
              : `Version ${version.code} has no ${tab.empty}.`
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
          <table className="w-full text-left font-condensed text-small">
            <thead className="bg-surface-sunken text-ink">
              <tr>
                <th scope="col" className={th}>{see ? 'CN code' : 'Applies to'}</th>
                <th scope="col" className={th}>Country</th>
                {grid && <th scope="col" className={th}>Region</th>}
                {(grid || see) && <th scope="col" className={`${th} text-right`}>Year</th>}
                {see && <th scope="col" className={th}>Component</th>}
                <th scope="col" className={`${th} text-right`}>Value</th>
                <th scope="col" className={th}>Plausible range</th>
                <th scope="col" className={th}>Valid</th>
                <th scope="col" className={th}>Source</th>
                {editable && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className="h-10 border-b border-rule align-middle last:border-b-0">
                  <td className="px-3 font-semibold text-ink">{f.subject}</td>
                  <td className="px-3 text-ink">{f.countryCode ?? 'All'}</td>
                  {grid && <td className="px-3 text-ink">{f.region ?? '—'}</td>}
                  {(grid || see) && <td className="px-3 text-right text-ink tabular-nums">{f.year ?? '—'}</td>}
                  {see && <td className="px-3 text-ink">{f.component === 'direct' ? 'Direct' : 'Indirect'}</td>}
                  <td className="px-3 text-right whitespace-nowrap text-ink tabular-nums">
                    {formatExact(f.value)} <span className="text-ink-muted">{unitLabel(f.unit)}</span>
                  </td>
                  <td className="px-3 whitespace-nowrap text-ink tabular-nums">
                    {f.plausibleMin || f.plausibleMax ? (
                      <>
                        {f.plausibleMin ? formatExact(f.plausibleMin) : '…'}–{f.plausibleMax ? formatExact(f.plausibleMax) : '…'}{' '}
                        <span className="text-ink-muted">{unitLabel(f.unit)}</span>
                      </>
                    ) : (
                      <span className="text-ink-muted">Not set</span>
                    )}
                  </td>
                  <td className="px-3 whitespace-nowrap text-ink tabular-nums">
                    {f.validFrom} – {f.validTo ?? 'open'}
                  </td>
                  <td className="max-w-[32ch] truncate px-3 text-ink" title={f.source}>{f.source}</td>
                  {editable && (
                    <td className="px-2 text-right whitespace-nowrap">
                      <Button variant="quiet" onClick={() => setEditing(f)}>Edit</Button>
                      <Button variant="destructive" onClick={() => setDeleting(f)}>Delete</Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? `Add ${FACTOR_KIND_LABELS[kind].toLowerCase()}` : `Edit ${editing.subject}`}>
          <div className="max-h-[70vh] overflow-y-auto">
            <FactorForm
              mode="library"
              kindLocked
              initial={factorFormValues(kind, editing === 'new' ? undefined : editing)}
              submitLabel="Save factor"
              onCancel={() => setEditing(null)}
              onSubmit={async (values) => {
                if (editing === 'new') await api.post(`/library/versions/${version.id}/factors`, values);
                else await api.patch(`/library/factors/${editing.id}`, values);
                await qc.invalidateQueries({ queryKey: libraryKeys.factors(version.id) });
                void refresh();
                toast('Factor saved');
                setEditing(null);
              }}
            />
          </div>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.subject}?`}
          consequence={`The factor is removed from draft ${version.code}. Published versions keep their copy.`}
          confirmLabel="Delete factor"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.delete(`/library/factors/${deleting.id}`);
            await qc.invalidateQueries({ queryKey: libraryKeys.factors(version.id) });
            void refresh();
            toast('Factor deleted');
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

import { type ClientDetail, ClientInput, can } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ContextBar } from '@/app/ContextBar';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PageHeader } from '@/components/PageHeader';
import { RecordForm, toFormValues } from '@/components/RecordForm';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { OverridesPanel } from '@/features/library/OverridesPanel';
import { api } from '@/lib/api';
import { useCountryName } from '@/lib/reference';
import { useMe } from '@/lib/session';
import { ImportersPanel } from './ImportersPanel';
import { type ClientBundle, keys, useClient } from './queries';
import { CLIENT_SECTIONS } from './sections';
import { TeamPanel } from './TeamPanel';
import { EvidencePanel } from '@/features/evidence/EvidencePanel';

/** Client profile (design system 6.2): operator details, installations, importers, team. */
export function ClientPage() {
  const { clientId = '' } = useParams();
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const countryName = useCountryName();
  const bundle = useClient(clientId);
  const [deleting, setDeleting] = useState(false);
  const canWrite = can(me.user.role, 'registry.write');

  if (bundle.isPending) return <div className="p-6"><SkeletonRows rows={8} /></div>;
  if (bundle.isError) {
    return (
      <div className="p-6">
        <ErrorState message={bundle.error.message} actions={<Link className="text-body font-semibold text-action underline" to="/">Open portfolio</Link>} />
      </div>
    );
  }
  const { client, installations, importers } = bundle.data;

  return (
    <>
      <ContextBar context={{ client: client.legalName ?? '' }} />
      <div className="p-6">
        <PageHeader
          title={client.legalName ?? ''}
          description={`${client.city}, ${countryName(client.countryCode)}`}
          actions={canWrite && <Button variant="destructive" onClick={() => setDeleting(true)}>Delete client</Button>}
        />

        <RecordForm
          mode="edit"
          readOnly={!canWrite}
          sections={CLIENT_SECTIONS}
          schema={ClientInput as never}
          values={toFormValues(client, CLIENT_SECTIONS)}
          onSave={async (patch) => {
            const { client: updated } = await api.patch<{ client: ClientDetail }>(`/clients/${clientId}`, patch);
            qc.setQueryData<ClientBundle>(keys.client(clientId), (old) => old && { ...old, client: updated });
            void qc.invalidateQueries({ queryKey: keys.clients });
          }}
        />

        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-h2 font-semibold text-ink">Installations</h2>
            {canWrite && <Button onClick={() => navigate(`/clients/${clientId}/installations/new`)}>Add installation</Button>}
          </div>
          {installations.length === 0 ? (
            <EmptyState
              message="No installations yet. Add the sites this operator runs outside the EU."
              actions={canWrite && <Button variant="primary" onClick={() => navigate(`/clients/${clientId}/installations/new`)}>Add installation</Button>}
            />
          ) : (
            <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
              <table className="w-full text-left text-small">
                <thead className="bg-surface-sunken text-ink">
                  <tr>
                    {['Installation', 'City', 'Country', 'UN/LOCODE'].map((h) => (
                      <th key={h} scope="col" className="h-8 border-b border-rule px-3 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {installations.map((i) => (
                    <tr key={i.id} className="h-10 border-b border-rule last:border-b-0 hover:bg-action-tint">
                      <td className="px-3 font-semibold">
                        <Link to={`/installations/${i.id}`} className="text-ink hover:underline">{i.nameEn}</Link>
                      </td>
                      <td className="px-3 text-ink">{i.city}</td>
                      <td className="px-3 text-ink">{countryName(i.countryCode)}</td>
                      <td className="px-3 font-mono text-ink">{i.unLocode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <ImportersPanel clientId={clientId} importers={importers} canWrite={canWrite} />
        <TeamPanel clientId={clientId} installations={installations} canManage={can(me.user.role, 'assignments.manage')} currentUserId={me.user.id} />
        <OverridesPanel clientId={clientId} />
        <EvidencePanel clientId={clientId} recordType="client" recordId={clientId} />
      </div>

      {deleting && (
        <ConfirmDialog
          title={`Delete ${client.legalName}?`}
          consequence="The client disappears from the portfolio for everyone. Its history stays in the audit trail. Delete its installations first."
          confirmLabel="Delete client"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.delete(`/clients/${clientId}`);
            await qc.invalidateQueries({ queryKey: keys.clients });
            toast('Client deleted');
            navigate('/', { replace: true });
          }}
        />
      )}
    </>
  );
}

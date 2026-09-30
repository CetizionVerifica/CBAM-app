import { type InstallationDetail, InstallationInput, can } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ContextBar } from '@/app/ContextBar';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PageHeader } from '@/components/PageHeader';
import { RecordForm, toFormValues } from '@/components/RecordForm';
import { ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { useCountryName } from '@/lib/reference';
import { useMe } from '@/lib/session';
import { EvidencePanel } from '@/features/evidence/EvidencePanel';
import { PeriodsPanel } from '@/features/periods/PeriodsPanel';
import { keys, useClient, useInstallation } from './queries';
import { INSTALLATION_SECTIONS } from './sections';

export function NewInstallationPage() {
  const { clientId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const client = useClient(clientId);
  if (client.isPending) return <div className="p-6"><SkeletonRows rows={8} /></div>;
  if (client.isError) return <div className="p-6"><ErrorState message={client.error.message} /></div>;

  return (
    <>
      <ContextBar context={{ client: client.data.client.legalName ?? '' }} />
      <div className="p-6">
        <PageHeader title="Add installation" description="Fields follow sheet A of the EU communication template." />
        <RecordForm
          mode="create"
          sections={INSTALLATION_SECTIONS}
          schema={InstallationInput as never}
          values={toFormValues({ countryCode: client.data.client.countryCode }, INSTALLATION_SECTIONS)}
          submitLabel="Add installation"
          onCancel={() => navigate(`/clients/${clientId}`)}
          onSubmit={async (values) => {
            const { installation } = await api.post<{ installation: InstallationDetail }>(`/clients/${clientId}/installations`, values);
            await qc.invalidateQueries({ queryKey: keys.client(clientId) });
            void qc.invalidateQueries({ queryKey: keys.clients });
            toast('Installation added');
            navigate(`/installations/${installation.id}`, { replace: true });
          }}
        />
      </div>
    </>
  );
}

/** Installation profile (design system 6.2). */
export function InstallationPage() {
  const { installationId = '' } = useParams();
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const countryName = useCountryName();
  const installation = useInstallation(installationId);
  const clientId = installation.data?.clientId ?? '';
  const client = useClient(clientId);
  const [deleting, setDeleting] = useState(false);
  const canWrite = can(me.user.role, 'registry.write');

  if (installation.isPending) return <div className="p-6"><SkeletonRows rows={8} /></div>;
  if (installation.isError) {
    return (
      <div className="p-6">
        <ErrorState message={installation.error.message} actions={<Link className="text-body font-semibold text-action underline" to="/">Open portfolio</Link>} />
      </div>
    );
  }
  const inst = installation.data;
  const osm =
    inst.latitude && inst.longitude
      ? `https://www.openstreetmap.org/?mlat=${inst.latitude}&mlon=${inst.longitude}#map=14/${inst.latitude}/${inst.longitude}`
      : null;

  return (
    <>
      <ContextBar context={{ client: client.data?.client.legalName ?? '…', installation: inst.nameEn ?? '' }} />
      <div className="p-6">
        <PageHeader
          title={inst.nameEn ?? ''}
          description={`${inst.city}, ${countryName(inst.countryCode)}`}
          actions={
            <>
              {client.data && <Button onClick={() => navigate(`/clients/${clientId}`)}>Open client</Button>}
              {canWrite && <Button variant="destructive" onClick={() => setDeleting(true)}>Delete installation</Button>}
            </>
          }
        />
        {osm && (
          <p className="mb-4 text-small text-ink-muted">
            Main emission source at <span className="tabular-nums text-ink">{inst.latitude}, {inst.longitude}</span> —{' '}
            <a href={osm} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-semibold text-action underline">
              check on a map <ExternalLink aria-hidden className="size-3.5" strokeWidth={1.5} />
            </a>
          </p>
        )}
        <RecordForm
          mode="edit"
          readOnly={!canWrite}
          sections={INSTALLATION_SECTIONS}
          schema={InstallationInput as never}
          values={toFormValues(inst, INSTALLATION_SECTIONS)}
          onSave={async (patch) => {
            const { installation: updated } = await api.patch<{ installation: InstallationDetail }>(`/installations/${installationId}`, patch);
            qc.setQueryData(keys.installation(installationId), updated);
            void qc.invalidateQueries({ queryKey: keys.client(clientId) });
          }}
        />
        <PeriodsPanel installationId={installationId} />
        <EvidencePanel clientId={clientId} installationId={installationId} recordType="installation" recordId={installationId} />
      </div>
      {deleting && (
        <ConfirmDialog
          title={`Delete ${inst.nameEn}?`}
          consequence="The installation disappears for everyone, and data contributors assigned to it lose access. Its history stays in the audit trail."
          confirmLabel="Delete installation"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.delete(`/installations/${installationId}`);
            await qc.invalidateQueries({ queryKey: keys.client(clientId) });
            void qc.invalidateQueries({ queryKey: keys.clients });
            toast('Installation deleted');
            navigate(`/clients/${clientId}`, { replace: true });
          }}
        />
      )}
    </>
  );
}

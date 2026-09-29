import { type ClientDetail, ClientInput } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { RecordForm, toFormValues } from '@/components/RecordForm';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { keys } from './queries';
import { CLIENT_SECTIONS } from './sections';

export function NewClientPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <div className="p-6">
      <PageHeader title="Add client" description="The operator company. Add its installations and EU importers next." />
      <RecordForm
        mode="create"
        sections={CLIENT_SECTIONS}
        schema={ClientInput as never}
        values={toFormValues(undefined, CLIENT_SECTIONS)}
        submitLabel="Add client"
        onCancel={() => navigate('/')}
        onSubmit={async (values) => {
          const { client } = await api.post<{ client: ClientDetail }>('/clients', values);
          await qc.invalidateQueries({ queryKey: keys.clients });
          toast('Client added');
          navigate(`/clients/${client.id}`, { replace: true });
        }}
      />
    </div>
  );
}

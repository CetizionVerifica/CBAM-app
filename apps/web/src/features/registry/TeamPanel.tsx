import { type InstallationDetail, ROLE_LABELS, type UserSummary } from '@cbam/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { SelectField } from '@/components/Field';
import { ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { ApiError, api } from '@/lib/api';
import { keys, useTeam } from './queries';

/**
 * Who works on this client (M1-R2): reviewers and recipients on the whole client,
 * data contributors on single installations. The API and database enforce who may
 * assign whom; this panel only offers the valid choices.
 */
export function TeamPanel({
  clientId,
  installations,
  canManage,
  currentUserId,
}: {
  clientId: string;
  installations: InstallationDetail[];
  canManage: boolean;
  currentUserId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const team = useTeam(clientId);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installationName = (id: string | null) => installations.find((i) => i.id === id)?.nameEn ?? 'Removed installation';
  const refresh = () => qc.invalidateQueries({ queryKey: keys.team(clientId) });

  const remove = async (userId: string, installationId: string | null) => {
    setError(null);
    try {
      await api.delete(installationId ? `/installations/${installationId}/team/${userId}` : `/clients/${clientId}/team/${userId}`);
      await refresh();
      toast('User removed');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-h2 font-semibold text-ink">Team</h2>
        {canManage && <Button onClick={() => setAssigning(true)}>Assign user</Button>}
      </div>
      {error && <div className="mb-3"><ErrorState message={error} /></div>}
      {team.isPending && <SkeletonRows rows={3} />}
      {team.isError && <ErrorState message={team.error.message} />}
      {team.data && (
        <ul className="divide-y divide-rule rounded-panel border border-rule bg-surface">
          {team.data.map((m) => (
            <li key={`${m.userId}-${m.installationId}`} className="flex items-center gap-4 px-4 py-2">
              <div className="flex-1">
                <p className="text-body font-semibold text-ink">{m.displayName}</p>
                <p className="text-small text-ink-muted">
                  {ROLE_LABELS[m.role]} · {m.installationId ? installationName(m.installationId) : 'Whole client'}
                </p>
              </div>
              {canManage && m.userId !== currentUserId && (
                <Button variant="destructive" onClick={() => void remove(m.userId, m.installationId)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {assigning && (
        <AssignDialog
          clientId={clientId}
          installations={installations}
          assigned={new Set(team.data?.map((m) => `${m.userId}:${m.installationId}`))}
          onClose={() => setAssigning(false)}
          onDone={async () => {
            setAssigning(false);
            await refresh();
            toast('User assigned');
          }}
        />
      )}
    </section>
  );
}

function AssignDialog({
  clientId,
  installations,
  assigned,
  onClose,
  onDone,
}: {
  clientId: string;
  installations: InstallationDetail[];
  assigned: Set<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: UserSummary[] }>('/users') });
  const candidates = (users.data?.users ?? []).filter((u) => u.status !== 'deactivated' && u.role !== 'platform_admin');
  const [userId, setUserId] = useState('');
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const user = candidates.find((u) => u.id === userId);
  const isContributor = user?.role === 'contributor';
  const already = user ? assigned.has(`${user.id}:${isContributor ? installationId : null}`) : false;

  const submit = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(isContributor ? `/installations/${installationId}/team/${user.id}` : `/clients/${clientId}/team/${user.id}`);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Assign user" description="Reviewers and report recipients see the whole client. Data contributors see only the installation you choose.">
      <div className="flex flex-col gap-4">
        {error && <ErrorState message={error} />}
        {users.isPending ? (
          <SkeletonRows rows={2} />
        ) : (
          <SelectField
            label="User"
            value={userId}
            onChange={(e) => setUserId((e.target as HTMLSelectElement).value)}
            options={[{ value: '', label: 'Choose a user…' }, ...candidates.map((u) => ({ value: u.id, label: `${u.displayName} — ${ROLE_LABELS[u.role]}` }))]}
          />
        )}
        {isContributor && (
          installations.length === 0 ? (
            <p className="text-body text-ink">Add an installation first; data contributors are assigned to installations.</p>
          ) : (
            <SelectField
              label="Installation"
              value={installationId}
              onChange={(e) => setInstallationId((e.target as HTMLSelectElement).value)}
              options={installations.map((i) => ({ value: i.id, label: i.nameEn ?? '' }))}
            />
          )
        )}
        {already && <p className="text-small text-ink-muted">This user is already assigned here.</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!user || busy || already || (isContributor && !installationId)} onClick={() => void submit()}>
            Assign user
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

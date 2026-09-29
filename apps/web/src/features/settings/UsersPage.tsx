import {
  DeactivateUserRequest,
  INVITABLE_ROLES,
  InviteUserRequest,
  ROLE_LABELS,
  USER_ROLES,
  type UserRole,
  type UserSummary,
  can,
} from '@cbam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDashed, CircleOff, MoreHorizontal, ShieldCheck, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, SelectField } from '@/components/Field';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { applyServerError } from '@/lib/forms';
import { useMe } from '@/lib/session';

const USERS_KEY = ['users'] as const;

const STATUS: Record<UserSummary['status'], { label: string; icon: typeof UserCheck; tint: string; iconColor: string }> = {
  active: { label: 'Active', icon: UserCheck, tint: 'bg-ok-tint', iconColor: 'text-ok' },
  invited: { label: 'Invited', icon: CircleDashed, tint: 'bg-info-tint', iconColor: 'text-info' },
  deactivated: { label: 'Deactivated', icon: CircleOff, tint: 'bg-locked-tint', iconColor: 'text-locked' },
};

function UserStatus({ status }: { status: UserSummary['status'] }) {
  const { label, icon: Icon, tint, iconColor } = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-input px-2 py-0.5 text-caption font-medium text-ink', tint)}>
      <Icon aria-hidden className={cn('size-3.5', iconColor)} strokeWidth={1.5} />
      {label}
    </span>
  );
}

type Dialogs =
  | { kind: 'invite' }
  | { kind: 'role'; user: UserSummary }
  | { kind: 'deactivate'; user: UserSummary }
  | null;

/** M1 users, roles and invitations (design system 6, spec M1 screens). */
export function UsersPage() {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => api.get<{ users: UserSummary[] }>('/users') });

  const refresh = () => qc.invalidateQueries({ queryKey: USERS_KEY });
  const role = me.user.role;
  const canManage = can(role, 'users.update');

  const rowAction = async (fn: () => Promise<unknown>, done: string) => {
    setRowError(null);
    try {
      await fn();
      await refresh();
      toast(done);
    } catch (e) {
      setRowError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Users"
        description={canManage ? 'Everyone with access to this workspace, their roles and sign-in status.' : 'You and the people you have invited.'}
        actions={
          can(role, 'users.invite') && (
            <Button variant="primary" onClick={() => setDialog({ kind: 'invite' })}>
              Invite user
            </Button>
          )
        }
      />

      {rowError && (
        <div className="mb-4">
          <ErrorState message={rowError} />
        </div>
      )}

      {users.isPending && <SkeletonRows />}
      {users.isError && (
        <ErrorState message={users.error.message} actions={<Button onClick={() => void users.refetch()}>Try again</Button>} />
      )}
      {users.data && users.data.users.length <= 1 && !canManage && (
        <EmptyState message="You haven't invited anyone yet. Invite the plant staff, reviewers or report recipients for your clients." />
      )}
      {users.data && (users.data.users.length > 1 || canManage) && (
        <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
          <table className="w-full text-left text-small">
            <thead className="bg-surface-sunken text-ink">
              <tr>
                {['Name', 'Email', 'Role', 'Status', 'Two-factor', ''].map((h, i) => (
                  <th key={i} scope="col" className="h-8 border-b border-rule px-3 font-semibold">
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id} className="h-10 border-b border-rule last:border-b-0">
                  <td className="px-3 font-semibold text-ink">
                    {u.displayName}
                    {u.id === me.user.id && <span className="ml-1 font-normal text-ink-muted">(you)</span>}
                  </td>
                  <td className="px-3 text-ink">{u.email}</td>
                  <td className="px-3 text-ink">{ROLE_LABELS[u.role]}</td>
                  <td className="px-3">
                    <UserStatus status={u.status} />
                  </td>
                  <td className="px-3 text-ink">
                    {u.twoFactorEnabled ? (
                      <span className="inline-flex items-center gap-1">
                        <ShieldCheck aria-hidden className="size-4 text-ok" strokeWidth={1.5} /> On
                      </span>
                    ) : (
                      <span className="text-ink-muted">Off</span>
                    )}
                  </td>
                  <td className="w-10 px-2 text-right">
                    {u.id !== me.user.id && (
                      <RowMenu
                        user={u}
                        canManage={canManage}
                        canResend={u.status === 'invited' && INVITABLE_ROLES[role].includes(u.role)}
                        onRole={() => setDialog({ kind: 'role', user: u })}
                        onDeactivate={() => setDialog({ kind: 'deactivate', user: u })}
                        onReactivate={() => void rowAction(() => api.post(`/users/${u.id}/reactivate`), `${u.displayName} reactivated`)}
                        onResend={() => void rowAction(() => api.post(`/users/${u.id}/invitations`), `Invitation resent to ${u.email}`)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'invite' && (
        <InviteDialog
          roles={INVITABLE_ROLES[role]}
          onClose={() => setDialog(null)}
          onDone={async (email) => {
            setDialog(null);
            await refresh();
            toast(`User invited — email sent to ${email}`);
          }}
        />
      )}
      {dialog?.kind === 'role' && (
        <RoleDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            await refresh();
            toast('Role changed');
          }}
        />
      )}
      {dialog?.kind === 'deactivate' && (
        <DeactivateDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            await refresh();
            toast(`${dialog.user.displayName} deactivated`);
          }}
        />
      )}
    </div>
  );
}

const menuItem = 'flex h-9 cursor-default items-center rounded-input px-2 text-body text-ink outline-none data-[highlighted]:bg-surface-sunken';

function RowMenu(props: {
  user: UserSummary;
  canManage: boolean;
  canResend: boolean;
  onRole: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onResend: () => void;
}) {
  const { user, canManage, canResend } = props;
  if (!canManage && !canResend) return null;
  return (
    <DM.Root>
      <DM.Trigger aria-label={`Actions for ${user.displayName}`} className="rounded-button p-1.5 text-ink-muted hover:bg-surface-sunken">
        <MoreHorizontal aria-hidden className="size-4" strokeWidth={1.5} />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" className="z-50 min-w-48 rounded-panel border border-rule bg-surface p-1 shadow-float">
          {canResend && (
            <DM.Item className={menuItem} onSelect={props.onResend}>
              Resend invitation
            </DM.Item>
          )}
          {canManage && user.status !== 'deactivated' && (
            <DM.Item className={menuItem} onSelect={props.onRole}>
              Change role
            </DM.Item>
          )}
          {canManage && user.status !== 'deactivated' && (
            <DM.Item className={cn(menuItem, 'text-critical')} onSelect={props.onDeactivate}>
              Deactivate user
            </DM.Item>
          )}
          {canManage && user.status === 'deactivated' && (
            <DM.Item className={menuItem} onSelect={props.onReactivate}>
              Reactivate user
            </DM.Item>
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

type InviteValues = z.input<typeof InviteUserRequest>;

function InviteDialog({ roles, onClose, onDone }: { roles: readonly UserRole[]; onClose: () => void; onDone: (email: string) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<InviteValues>({
    resolver: zodResolver(InviteUserRequest),
    mode: 'onBlur',
    defaultValues: { email: '', displayName: '', role: roles.includes('contributor') ? 'contributor' : roles[0]! },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/users/invitations', values);
      onDone(values.email);
    } catch (e) {
      setFormError(applyServerError(e, form.setError));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Invite user" description="They get an email with a link to set their password. The link works once and expires in 72 hours.">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError && <ErrorState message={formError} />}
        <Field label="Name" autoFocus error={form.formState.errors.displayName?.message} {...form.register('displayName')} />
        <Field label="Email" type="email" error={form.formState.errors.email?.message} {...form.register('email')} />
        <SelectField label="Role" options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} error={form.formState.errors.role?.message} {...form.register('role')} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
            Invite user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RoleDialog({ user, onClose, onDone }: { user: UserSummary; onClose: () => void; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole>(user.role);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await api.patch(`/users/${user.id}`, { role });
      onDone();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Change role — ${user.displayName}`} description="The new role applies at their next request. The change is recorded in the audit trail.">
      <div className="flex flex-col gap-4">
        {formError && <ErrorState message={formError} />}
        <SelectField
          label="Role"
          value={role}
          onChange={(e) => setRole((e.target as HTMLSelectElement).value as UserRole)}
          options={USER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || role === user.role} onClick={() => void submit()}>
            Change role
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DeactivateDialog({ user, onClose, onDone }: { user: UserSummary; onClose: () => void; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<{ reason: string }>({ resolver: zodResolver(DeactivateUserRequest), defaultValues: { reason: '' } });
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post(`/users/${user.id}/deactivate`, values);
      onDone();
    } catch (e) {
      setFormError(applyServerError(e, form.setError));
    }
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Deactivate ${user.displayName}?`}
      description="They are signed out everywhere at once and can't sign in again until reactivated. Their changes stay in the audit trail."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError && <ErrorState message={formError} />}
        <Field label="Reason" autoFocus error={form.formState.errors.reason?.message} {...form.register('reason')} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="confirmDestructive" disabled={form.formState.isSubmitting}>
            Deactivate user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

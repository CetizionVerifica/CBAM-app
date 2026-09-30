import { FACTOR_KIND_LABELS, type FactorOverride, type OverrideStatus, can } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleDashed, CircleOff, Flag, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field } from '@/components/Field';
import { ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatExact, unitLabel } from '@/lib/format';
import { useMe } from '@/lib/session';
import { FactorForm, factorFormValues } from './FactorForm';
import { libraryKeys, useOverrides } from './queries';

const STATUS: Record<OverrideStatus, { label: string; icon: typeof Check; tint: string; iconColor: string }> = {
  proposed: { label: 'Proposed', icon: CircleDashed, tint: 'bg-info-tint', iconColor: 'text-info' },
  approved: { label: 'Approved', icon: Check, tint: 'bg-ok-tint', iconColor: 'text-ok' },
  rejected: { label: 'Rejected', icon: X, tint: 'bg-critical-tint', iconColor: 'text-critical' },
  withdrawn: { label: 'Withdrawn', icon: CircleOff, tint: 'bg-locked-tint', iconColor: 'text-locked' },
};

function OverrideStatusBadge({ status }: { status: OverrideStatus }) {
  const { label, icon: Icon, tint, iconColor } = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-input px-2 py-0.5 text-caption font-medium text-ink', tint)}>
      <Icon aria-hidden className={cn('size-3.5', iconColor)} strokeWidth={1.5} />
      {label}
    </span>
  );
}

const th = 'h-8 border-b border-rule px-3 font-semibold whitespace-nowrap';

type Decision = { override: FactorOverride; action: 'approve' | 'reject' | 'withdraw' };

/**
 * M4-R5: client-specific factor overrides on the client profile. Each one is flagged as an
 * override and shown next to the library value it replaces.
 */
export function OverridesPanel({ clientId }: { clientId: string }) {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const overrides = useOverrides(clientId);
  const [proposing, setProposing] = useState(false);
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const canPropose = can(me.user.role, 'overrides.propose');
  const canDecide = can(me.user.role, 'overrides.decide');
  const refresh = () => qc.invalidateQueries({ queryKey: libraryKeys.overrides(clientId) });

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-h2 font-semibold text-ink">Factor overrides</h2>
          <p className="text-small text-ink-muted">Client-specific values that replace a library factor once a platform admin approves them.</p>
        </div>
        {canPropose && <Button onClick={() => setProposing(true)}>Propose override</Button>}
      </div>
      {overrides.isPending ? (
        <SkeletonRows rows={2} />
      ) : overrides.isError ? (
        <ErrorState message={overrides.error.message} />
      ) : overrides.data.length === 0 ? (
        <p className="rounded-panel border border-rule bg-surface p-4 text-body text-ink-muted">
          No overrides. This client uses the library values.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
          <table className="w-full text-left text-small">
            <thead className="bg-surface-sunken text-ink">
              <tr>
                <th scope="col" className={th}>Factor</th>
                <th scope="col" className={`${th} text-right`}>Override</th>
                <th scope="col" className={`${th} text-right`}>Library value</th>
                <th scope="col" className={th}>Valid</th>
                <th scope="col" className={th}>Justification and source</th>
                <th scope="col" className={th}>Status</th>
                <th scope="col" className={th}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {overrides.data.map((o) => (
                <tr key={o.id} className="border-b border-rule align-top last:border-b-0">
                  <td className="px-3 py-2 text-ink">
                    <div className="flex items-center gap-1 font-semibold">
                      <Flag aria-label="Client override" className="size-3.5 text-warn" strokeWidth={1.5} />
                      {o.subject}
                    </div>
                    <div className="text-ink-muted">
                      {[FACTOR_KIND_LABELS[o.kind], o.countryCode, o.region, o.year, o.component].filter((x) => x != null).join(' · ')}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-ink tabular-nums">
                    {formatExact(o.value)} <span className="text-ink-muted">{unitLabel(o.unit)}</span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-ink tabular-nums">
                    {o.libraryValue ? (
                      <>
                        {formatExact(o.libraryValue.value)} <span className="text-ink-muted">{unitLabel(o.libraryValue.unit)}</span>
                        <div className="text-caption text-ink-muted">library {o.libraryValue.versionCode}</div>
                      </>
                    ) : (
                      <span className="text-ink-muted">Not in library</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink tabular-nums">{o.validFrom} – {o.validTo ?? 'open'}</td>
                  <td className="max-w-[40ch] px-3 py-2 text-ink">
                    <div>{o.justification}</div>
                    <div className="text-ink-muted">{o.source}</div>
                    <div className="text-caption text-ink-muted">Proposed by {o.proposedByName ?? 'a consultant'} on {o.proposedAt.slice(0, 10)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <OverrideStatusBadge status={o.status} />
                    {o.decidedAt && (
                      <div className="mt-1 text-caption text-ink-muted">
                        by {o.decidedByName ?? 'a platform admin'} on {o.decidedAt.slice(0, 10)}
                        {o.decisionNote && <>: {o.decisionNote}</>}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    {canDecide && o.status === 'proposed' && (
                      <>
                        <Button variant="quiet" onClick={() => setDeciding({ override: o, action: 'approve' })}>Approve</Button>
                        <Button variant="destructive" onClick={() => setDeciding({ override: o, action: 'reject' })}>Reject</Button>
                      </>
                    )}
                    {(o.status === 'proposed' || o.status === 'approved') && (canDecide || (canPropose && o.proposedBy === me.user.id)) && (
                      <Button variant="quiet" onClick={() => setDeciding({ override: o, action: 'withdraw' })}>Withdraw</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {proposing && (
        <Dialog open onOpenChange={(o) => !o && setProposing(false)} title="Propose override" description="A platform admin approves or rejects it. Until then the library value applies.">
          <div className="max-h-[70vh] overflow-y-auto">
            <FactorForm
              mode="override"
              kindLocked={false}
              initial={factorFormValues('emission_factor')}
              submitLabel="Propose override"
              onCancel={() => setProposing(false)}
              onSubmit={async (values) => {
                await api.post(`/clients/${clientId}/factor-overrides`, values);
                await refresh();
                toast('Override proposed');
                setProposing(false);
              }}
            />
          </div>
        </Dialog>
      )}
      {deciding && (
        <DecisionDialog
          decision={deciding}
          onClose={() => setDeciding(null)}
          onDone={async (message) => {
            await refresh();
            toast(message);
            setDeciding(null);
          }}
        />
      )}
    </section>
  );
}

const DECISION = {
  approve: { title: 'Approve override', label: 'Approve override', toast: 'Override approved', note: 'Note (optional)', consequence: 'Calculations for this client use this value instead of the library value, flagged as an override.' },
  reject: { title: 'Reject override', label: 'Reject override', toast: 'Override rejected', note: 'Reason', consequence: 'The library value keeps applying. The consultant sees your reason.' },
  withdraw: { title: 'Withdraw override', label: 'Withdraw override', toast: 'Override withdrawn', note: '', consequence: 'The library value applies again. The override stays in the history.' },
} as const;

function DecisionDialog({ decision, onClose, onDone }: { decision: Decision; onClose: () => void; onDone: (toast: string) => Promise<void> }) {
  const d = DECISION[decision.action];
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/factor-overrides/${decision.override.id}/${decision.action}`, decision.action === 'withdraw' ? {} : { note });
      await onDone(d.toast);
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${d.title}: ${decision.override.subject}`} description={d.consequence}>
      <div className="flex flex-col gap-4">
        {d.note && <Field label={d.note} value={note} onChange={(e) => setNote(e.target.value)} />}
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={decision.action === 'approve' ? 'primary' : 'confirmDestructive'} disabled={busy} onClick={submit}>{d.label}</Button>
        </div>
      </div>
    </Dialog>
  );
}

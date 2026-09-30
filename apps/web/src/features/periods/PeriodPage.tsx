import {
  PERIOD_TRANSITIONS,
  type PeriodAction,
  type PeriodDetail,
  can,
  isPeriodLocked,
  nextPeriodStart,
  periodEndDate,
  periodActionsFor,
  periodLabel,
} from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ContextBar } from '@/app/ContextBar';
import { Button } from '@/components/Button';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LockedBanner, SkeletonRows } from '@/components/States';
import { StatusBadge } from '@/components/StatusBadge';
import { useToast } from '@/components/Toast';
import { ApiError, api } from '@/lib/api';
import { formatDate, formatMoment } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/session';
import { EvidencePanel } from '@/features/evidence/EvidencePanel';
import { PeriodFormDialog, TransitionDialog, needsConfirmation } from './PeriodDialogs';
import { VerificationSection } from './VerificationSection';
import { periodKeys, usePeriod } from './queries';

const TOAST: Record<PeriodAction, string> = {
  submit: 'Submitted for review',
  approve: 'Period approved',
  issue: 'Period issued',
  reopen: 'Returned to draft',
};

/** Period overview (design system 6.3): status, versions, pinned library and template, history. */
export function PeriodPage() {
  const { periodId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const period = usePeriod(periodId);
  const [dialog, setDialog] = useState<null | { kind: 'transition'; action: PeriodAction } | { kind: 'dates' } | { kind: 'clone' }>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (period.isPending) {
    return (
      <div className="p-6">
        <SkeletonRows rows={8} />
      </div>
    );
  }
  if (period.isError) {
    return (
      <div className="p-6">
        <ErrorState message={period.error.message} actions={<Link className="text-body font-semibold text-action underline" to="/">Open portfolio</Link>} />
      </div>
    );
  }

  const p = period.data;
  const label = periodLabel(p.startDate, p.endDate);
  const latest = p.versions[0]!;
  const selectedNo = Number(search.get('version')) || latest.versionNo;
  const version = p.versions.find((v) => v.versionNo === selectedNo) ?? latest;
  const isLatest = version.id === latest.id;
  const locked = isPeriodLocked(version.status);
  const canManage = can(me.user.role, 'periods.manage');
  // The period right after this one, so clones tile without gaps.
  const cloneStart = nextPeriodStart(p.endDate);
  const actions = isLatest ? periodActionsFor(me.user.role, version.status) : [];

  const update = (next: PeriodDetail) => {
    qc.setQueryData(periodKeys.period(periodId), next);
    void qc.invalidateQueries({ queryKey: periodKeys.ofInstallation(next.installationId) });
  };

  const transition = async (action: PeriodAction, reason?: string) => {
    const { period: next } = await api.post<{ period: PeriodDetail }>(`/period-versions/${version.id}/transitions`, { action, reason });
    update(next);
    setDialog(null);
    toast(TOAST[action]);
  };

  const createVersion = async () => {
    setActionError(null);
    try {
      const { period: next } = await api.post<{ period: PeriodDetail }>(`/periods/${periodId}/versions`);
      update(next);
      setSearch({});
      toast(`Version ${next.versions[0]!.versionNo} created`);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  const lockMessage =
    version.status === 'issued'
      ? `Version ${version.versionNo} is issued and read-only.${isLatest ? ' Create a new version to make changes.' : ''}`
      : PERIOD_TRANSITIONS.reopen.roles.includes(me.user.role)
        ? 'This period is approved and read-only. Return it to draft to make changes.'
        : 'This period is approved and read-only. A consultant can return it to draft.';

  return (
    <>
      <ContextBar context={{ client: p.clientName, installation: p.installationName, period: { label, status: version.status } }} />
      {locked && (
        <LockedBanner
          message={lockMessage}
          action={
            isLatest && version.status === 'issued' && canManage ? (
              <Button variant="quiet" onClick={createVersion}>Create new version</Button>
            ) : undefined
          }
        />
      )}
      <div className="p-6">
        {!isLatest && (
          <p className="mb-4 text-body text-ink">
            You are viewing version {version.versionNo}.{' '}
            <button type="button" className="font-semibold text-action underline" onClick={() => setSearch({})}>
              Open version {latest.versionNo}
            </button>{' '}
            to see the working version.
          </p>
        )}
        <PageHeader
          title={`${label} reporting period`}
          description={`${formatDate(p.startDate)} – ${formatDate(p.endDate)} · Version ${version.versionNo}`}
          actions={
            <>
              {canManage && p.datesEditable && <Button onClick={() => setDialog({ kind: 'dates' })}>Edit period dates</Button>}
              {canManage && <Button onClick={() => setDialog({ kind: 'clone' })}>Clone to {periodLabel(cloneStart, periodEndDate(cloneStart))}</Button>}
              {actions.map((a) => (
                <Button
                  key={a}
                  variant={a === 'reopen' ? 'secondary' : 'primary'}
                  onClick={async () => {
                    setActionError(null);
                    if (needsConfirmation(a)) return setDialog({ kind: 'transition', action: a });
                    try {
                      await transition(a);
                    } catch (e) {
                      setActionError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
                    }
                  }}
                >
                  {PERIOD_TRANSITIONS[a].label}
                </Button>
              ))}
            </>
          }
        />
        {actionError && (
          <div className="mb-4">
            <ErrorState message={actionError} />
          </div>
        )}

        <dl className="mb-8 grid max-w-[880px] grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-body">
          <dt className="text-ink-muted">Status</dt>
          <dd><StatusBadge status={version.status} /></dd>
          <dt className="text-ink-muted">Factor library</dt>
          <dd className="font-mono text-ink">{version.libraryVersion.code}</dd>
          <dt className="text-ink-muted">EU template</dt>
          <dd className="font-mono text-ink">{version.templateVersion.code}</dd>
          {p.justification && (
            <>
              <dt className="text-ink-muted">Why not the calendar year</dt>
              <dd className="text-ink">{p.justification}</dd>
            </>
          )}
          {version.approvedAt && (
            <>
              <dt className="text-ink-muted">Approved</dt>
              <dd className="tabular-nums text-ink">{formatMoment(version.approvedAt)}</dd>
            </>
          )}
          {version.issuedAt && (
            <>
              <dt className="text-ink-muted">Issued</dt>
              <dd className="tabular-nums text-ink">{formatMoment(version.issuedAt)}</dd>
            </>
          )}
        </dl>

        {p.versions.length > 1 && (
          <section className="mb-8">
            <h2 className="mb-3 text-h2 font-semibold text-ink">Versions</h2>
            <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
              <table className="w-full text-left text-small">
                <thead className="bg-surface-sunken text-ink">
                  <tr>
                    {['Version', 'Status', 'Library', 'Template', 'Based on', 'Issued'].map((h) => (
                      <th key={h} scope="col" className="h-8 border-b border-rule px-3 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {p.versions.map((v) => (
                    <tr key={v.id} className={cn('h-10 border-b border-rule last:border-b-0 hover:bg-action-tint', v.id === version.id && 'bg-action-tint')}>
                      <td className="px-3 font-semibold">
                        <button
                          type="button"
                          className="text-ink hover:underline"
                          aria-current={v.id === version.id ? 'true' : undefined}
                          onClick={() => setSearch(v.id === latest.id ? {} : { version: String(v.versionNo) })}
                        >
                          Version {v.versionNo}
                        </button>
                      </td>
                      <td className="px-3"><StatusBadge status={v.status} /></td>
                      <td className="px-3 font-mono text-ink">{v.libraryVersion.code}</td>
                      <td className="px-3 font-mono text-ink">{v.templateVersion.code}</td>
                      <td className="px-3 tabular-nums text-ink">{v.basedOnVersionNo ? `Version ${v.basedOnVersionNo}` : '—'}</td>
                      <td className="px-3 tabular-nums text-ink">{v.issuedAt ? formatMoment(v.issuedAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="mb-8">
          <h2 className="mb-3 text-h2 font-semibold text-ink">Verification</h2>
          <VerificationSection key={version.id} versionId={version.id} locked={locked} />
        </section>

        <div className="mb-8">
          <EvidencePanel
            key={version.id}
            clientId={p.clientId}
            installationId={p.installationId}
            recordType="period_version"
            recordId={version.id}
            locked={locked}
          />
        </div>

        <section>
          <h2 className="mb-3 text-h2 font-semibold text-ink">History</h2>
          <ol className="flex max-w-[880px] flex-col rounded-panel border border-rule bg-surface">
            {p.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule px-4 py-3 last:border-b-0">
                <span className="w-40 shrink-0 text-small tabular-nums text-ink-muted">{formatMoment(h.changedAt)}</span>
                <span className="text-small text-ink-muted">Version {h.versionNo}</span>
                {h.fromStatus ? (
                  <span className="flex items-center gap-2">
                    <StatusBadge status={h.fromStatus} />
                    <ArrowRight aria-label="to" className="size-4 text-ink-muted" strokeWidth={1.5} />
                    <StatusBadge status={h.toStatus} />
                  </span>
                ) : (
                  <span className="text-body text-ink">Opened as <StatusBadge status={h.toStatus} /></span>
                )}
                <span className="text-body text-ink">{h.changedBy ?? 'A user you cannot see'}</span>
                {h.reason && <p className="basis-full sm:pl-43 text-body text-ink">“{h.reason}”</p>}
              </li>
            ))}
          </ol>
        </section>
      </div>

      {dialog?.kind === 'transition' && (
        <TransitionDialog action={dialog.action} periodLabel={label} onClose={() => setDialog(null)} onConfirm={(reason) => transition(dialog.action, reason)} />
      )}
      {dialog?.kind === 'dates' && (
        <PeriodFormDialog
          title="Edit period dates"
          description="Dates can change only while version 1 is a draft."
          submitLabel="Save period dates"
          initial={{ startDate: p.startDate, justification: p.justification }}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            const { period: next } = await api.patch<{ period: PeriodDetail }>(`/periods/${periodId}`, input);
            update(next);
            setDialog(null);
            toast('Period dates saved');
          }}
        />
      )}
      {dialog?.kind === 'clone' && (
        <PeriodFormDialog
          title={`Clone ${label}`}
          description="The new period gets this period’s set-up (processes, source streams, CN codes) but no activity data, and uses the current library and template versions."
          submitLabel="Clone period"
          initial={{ startDate: cloneStart, justification: p.justification }}
          onClose={() => setDialog(null)}
          onSubmit={async (input) => {
            const { period: next } = await api.post<{ period: PeriodDetail }>(`/periods/${periodId}/clone`, input);
            qc.setQueryData(periodKeys.period(next.id), next);
            void qc.invalidateQueries({ queryKey: periodKeys.ofInstallation(next.installationId) });
            setDialog(null);
            toast('Period cloned');
            navigate(`/periods/${next.id}`);
          }}
        />
      )}
    </>
  );
}

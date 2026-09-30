import { type GoodsCategoryEntry, MAX_PROCESSES, type PeriodDetail, type ProcessDetail, type ProcessStatus, can, periodLabel } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, type LucideIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ContextBar } from '@/app/ContextBar';
import { Button } from '@/components/Button';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LockedBanner, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatExact } from '@/lib/format';
import { useMe } from '@/lib/session';
import { useGoods } from '@/features/library/queries';
import { usePeriod } from '@/features/periods/queries';
import { SetupDialog } from './ProcessDialogs';
import { processKeys, useProcessList } from './queries';

const th = 'h-8 border-b border-rule px-3 font-semibold whitespace-nowrap';

const SECTOR_TOKEN: Record<string, string> = {
  cement: 'bg-[var(--sector-cement)]',
  iron_steel: 'bg-[var(--sector-iron-steel)]',
  aluminium: 'bg-[var(--sector-aluminium)]',
  fertilisers: 'bg-[var(--sector-fertilisers)]',
  hydrogen: 'bg-[var(--sector-hydrogen)]',
  electricity: 'bg-[var(--sector-electricity)]',
};

/** Sector swatch before process and goods names (design system 5.4). */
export function SectorSwatch({ sector }: { sector?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', (sector && SECTOR_TOKEN[sector]) ?? 'bg-rule-strong')} />;
}

const PROCESS_STATUS: Record<ProcessStatus, { label: string; icon: LucideIcon; tint: string; iconColor: string }> = {
  draft: { label: 'Draft', icon: CircleDashed, tint: 'bg-surface-sunken', iconColor: 'text-ink-muted' },
  complete: { label: 'Complete', icon: CheckCircle2, tint: 'bg-ok-tint', iconColor: 'text-ok' },
};

export function ProcessStatusBadge({ status }: { status: ProcessStatus }) {
  const { label, icon: Icon, tint, iconColor } = PROCESS_STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-input px-2 py-0.5 text-caption font-medium text-ink', tint)}>
      <Icon aria-hidden className={cn('size-3.5', iconColor)} strokeWidth={1.5} />
      {label}
    </span>
  );
}

/** Critical and warning counts; icon and number, never colour alone (design system 10). */
export function CheckCounts({ critical, warning }: { critical: number; warning: number }) {
  if (critical === 0 && warning === 0) return <span className="text-ink-muted">None</span>;
  return (
    <span className="inline-flex items-center gap-3 tabular-nums text-ink">
      {critical > 0 && (
        <span className="inline-flex items-center gap-1">
          <AlertTriangle aria-hidden className="size-3.5 text-critical" strokeWidth={1.5} />
          {critical} critical
        </span>
      )}
      {warning > 0 && (
        <span className="inline-flex items-center gap-1">
          <AlertTriangle aria-hidden className="size-3.5 text-warn" strokeWidth={1.5} />
          {warning} {warning === 1 ? 'warning' : 'warnings'}
        </span>
      )}
    </span>
  );
}

/** The period and version a process screen works on: the latest, or ?version=n. */
export function usePeriodVersion() {
  const { periodId = '' } = useParams();
  const [search] = useSearchParams();
  const period = usePeriod(periodId);
  const p = period.data;
  const latest = p?.versions[0];
  const version = p?.versions.find((v) => v.versionNo === Number(search.get('version'))) ?? latest;
  return { periodId, period, version, isLatest: version?.id === latest?.id, versionQuery: version && version.id !== latest?.id ? `?version=${version.versionNo}` : '' };
}

/** Context bar and locked banner (design system 4) around every process screen. */
export function PeriodFrame({ period, status, locked, children }: { period: PeriodDetail; status: PeriodDetail['versions'][number]['status']; locked: boolean; children: ReactNode }) {
  return (
    <>
      <ContextBar context={{ client: period.clientName, installation: period.installationName, period: { label: periodLabel(period.startDate, period.endDate), status } }} />
      {locked && (
        <LockedBanner
          message={
            status === 'issued'
              ? 'This period is issued and read-only. Create a new version to make changes.'
              : 'This period is approved and read-only. Return it to draft to make changes.'
          }
        />
      )}
      <div className="p-6">{children}</div>
    </>
  );
}

/** Process builder, list (design system 6.4; M5): P1–P10 with status and open checks. */
export function ProcessListPage() {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { periodId, period, version, versionQuery } = usePeriodVersion();
  const list = useProcessList(version?.id ?? '');
  const goods = useGoods(list.data?.libraryVersion.id ?? '');
  const [adding, setAdding] = useState(false);

  if (period.isPending || (version && list.isPending)) {
    return (
      <div className="p-6">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  const loadError = period.error ?? list.error;
  if (loadError || !period.data || !version || !list.data) {
    return (
      <div className="p-6">
        <ErrorState message={loadError?.message ?? 'This reporting period does not exist or you do not have access to it.'} actions={<Link className="text-body font-semibold text-action underline" to="/">Open portfolio</Link>} />
      </div>
    );
  }

  const l = list.data;
  const canConfigure = can(me.user.role, 'processes.configure') && !l.locked;
  const full = l.processes.length >= MAX_PROCESSES;
  const sector = new Map((goods.data ?? []).map((g: GoodsCategoryEntry) => [g.code, g.sector]));
  const addButton = canConfigure && (
    <Button variant="primary" disabled={full || !goods.data} onClick={() => setAdding(true)}>
      Add process
    </Button>
  );

  return (
    <PeriodFrame period={period.data} status={version.status} locked={l.locked}>
      <PageHeader
        title="Processes and goods"
        description={`Production processes, routes and the CN codes they make. Library ${l.libraryVersion.code}.`}
        actions={addButton}
      />
      <p className="mb-4 text-small text-ink-muted">
        <Link className="font-semibold text-action underline" to={`/periods/${periodId}${versionQuery}`}>Back to the period overview</Link>
      </p>
      {goods.isError && <div className="mb-4"><ErrorState message={goods.error.message} /></div>}
      {l.processes.length === 0 ? (
        <EmptyState
          message={
            canConfigure
              ? 'No processes yet. Add one process per aggregated goods category, or one for a group of categories made inside the same boundary.'
              : 'No processes yet. A consultant sets them up.'
          }
          actions={addButton}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
            <table className="w-full text-left text-small">
              <thead className="bg-surface-sunken text-ink">
                <tr>
                  <th scope="col" className={th}>Process</th>
                  <th scope="col" className={th}>Aggregated goods category</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={cn(th, 'text-right')}>Activity level</th>
                  <th scope="col" className={cn(th, 'text-right')}>Goods</th>
                  <th scope="col" className={th}>Open checks</th>
                </tr>
              </thead>
              <tbody>
                {l.processes.map((p) => (
                  <tr key={p.id} className="h-10 border-b border-rule last:border-b-0 hover:bg-action-tint">
                    <td className="px-3">
                      <Link className="inline-flex items-center gap-2 font-semibold text-ink hover:underline" to={`/periods/${periodId}/processes/${p.id}${versionQuery}`}>
                        <span className="font-mono text-ink-muted">P{p.position}</span>
                        <SectorSwatch sector={sector.get(p.goodsCategory.code)} />
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-3 text-ink">{p.goodsCategory.name}</td>
                    <td className="px-3"><ProcessStatusBadge status={p.status} /></td>
                    <td className="px-3 text-right tabular-nums text-ink">
                      {p.activityLevel === null ? <span className="text-ink-muted">Not entered</span> : <>{formatExact(p.activityLevel)} <span className="text-ink-muted">{p.goodsCategory.unit}</span></>}
                    </td>
                    <td className="px-3 text-right tabular-nums text-ink">{p.goodsCount}</td>
                    <td className="px-3"><CheckCounts {...p.openChecks} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-small text-ink-muted">
            <span className="tabular-nums">{l.processes.length}</span> of <span className="tabular-nums">{MAX_PROCESSES}</span> processes (the template has rows P1–P{MAX_PROCESSES}).
          </p>
        </>
      )}
      {adding && goods.data && (
        <SetupDialog
          title="Add process"
          submitLabel="Add process"
          library={goods.data}
          onClose={() => setAdding(false)}
          onSubmit={async (v) => {
            const { process } = await api.post<{ process: ProcessDetail }>(`/period-versions/${version.id}/processes`, v);
            qc.setQueryData(processKeys.process(process.id), process);
            void qc.invalidateQueries({ queryKey: processKeys.ofVersion(version.id) });
            setAdding(false);
            toast('Process added');
            navigate(`/periods/${periodId}/processes/${process.id}${versionQuery}`);
          }}
        />
      )}
    </PeriodFrame>
  );
}

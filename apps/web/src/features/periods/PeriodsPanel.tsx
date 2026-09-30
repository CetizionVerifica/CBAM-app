import { can, periodLabel } from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/Button';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { StatusBadge } from '@/components/StatusBadge';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useMe } from '@/lib/session';
import type { PeriodDetail } from '@cbam/shared';
import { PeriodFormDialog } from './PeriodDialogs';
import { periodKeys, useInstallationPeriods } from './queries';

/** Next calendar year after the newest period, or the current year for the first one. */
const suggestedStart = (latestStart?: string) => `${latestStart ? Number(latestStart.slice(0, 4)) + 1 : new Date().getFullYear()}-01-01`;

/** Reporting periods of one installation (M3), on the installation profile. */
export function PeriodsPanel({ installationId }: { installationId: string }) {
  const me = useMe().data!;
  const periods = useInstallationPeriods(installationId);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const canManage = can(me.user.role, 'periods.manage');

  const openButton = (variant: 'primary' | 'secondary') =>
    canManage && (
      <Button variant={variant} onClick={() => setOpening(true)}>
        Open reporting period
      </Button>
    );

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-h2 font-semibold text-ink">Reporting periods</h2>
        {periods.data && periods.data.length > 0 && openButton('secondary')}
      </div>
      {periods.isPending ? (
        <SkeletonRows rows={2} />
      ) : periods.isError ? (
        <ErrorState message={periods.error.message} actions={<Button onClick={() => periods.refetch()}>Try again</Button>} />
      ) : periods.data.length === 0 ? (
        <EmptyState
          message={
            canManage
              ? 'No reporting periods yet. Open one to start collecting data for this installation.'
              : 'No reporting periods yet. A consultant opens them.'
          }
          actions={openButton('primary')}
        />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
          <table className="w-full text-left text-small">
            <thead className="bg-surface-sunken text-ink">
              <tr>
                {['Reporting period', 'Dates', 'Status', 'Version', 'Library'].map((h) => (
                  <th key={h} scope="col" className="h-8 border-b border-rule px-3 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.data.map((p) => (
                <tr key={p.id} className="h-10 border-b border-rule last:border-b-0 hover:bg-action-tint">
                  <td className="px-3 font-semibold">
                    <Link to={`/periods/${p.id}`} className="text-ink hover:underline">{periodLabel(p.startDate, p.endDate)}</Link>
                  </td>
                  <td className="px-3 tabular-nums text-ink">{formatDate(p.startDate)} – {formatDate(p.endDate)}</td>
                  <td className="px-3"><StatusBadge status={p.latest.status} /></td>
                  <td className="px-3 tabular-nums text-ink">{p.latest.versionNo}</td>
                  <td className="px-3 font-mono text-ink">{p.latest.libraryVersion.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {opening && (
        <PeriodFormDialog
          title="Open reporting period"
          description="Version 1 starts as a draft and uses the current library and template versions."
          submitLabel="Open reporting period"
          initial={{ startDate: suggestedStart(periods.data?.[0]?.startDate) }}
          onClose={() => setOpening(false)}
          onSubmit={async (input) => {
            const { period } = await api.post<{ period: PeriodDetail }>(`/installations/${installationId}/periods`, input);
            qc.setQueryData(periodKeys.period(period.id), period);
            void qc.invalidateQueries({ queryKey: periodKeys.ofInstallation(installationId) });
            toast('Reporting period opened');
            navigate(`/periods/${period.id}`);
          }}
        />
      )}
    </section>
  );
}

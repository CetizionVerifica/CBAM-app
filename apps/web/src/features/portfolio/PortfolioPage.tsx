import { can } from '@cbam/shared';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/Button';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useClients } from '@/features/registry/queries';
import { useCountryName } from '@/lib/reference';
import { useMe } from '@/lib/session';

/**
 * Design system 6.1: a sortable table of clients, not cards. Sector, period, status and
 * issue columns join as M3/M5/M11 provide them.
 */
export function PortfolioPage() {
  const me = useMe().data!;
  const clients = useClients();
  const countryName = useCountryName();
  const navigate = useNavigate();
  const canAdd = can(me.user.role, 'registry.write');

  return (
    <div className="p-6">
      <PageHeader
        title="Portfolio"
        description="All clients and what needs attention today."
        actions={canAdd && <Button variant="primary" onClick={() => navigate('/clients/new')}>Add client</Button>}
      />
      {clients.isPending && <SkeletonRows />}
      {clients.isError && <ErrorState message={clients.error.message} actions={<Button onClick={() => void clients.refetch()}>Try again</Button>} />}
      {clients.data?.length === 0 && (
        <EmptyState
          message={canAdd ? 'No clients yet. Add the first operator you report for.' : 'No clients yet. Clients you are assigned to appear here.'}
          actions={canAdd && <Button variant="primary" onClick={() => navigate('/clients/new')}>Add client</Button>}
        />
      )}
      {clients.data && clients.data.length > 0 && (
        <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
          <table className="w-full text-left text-small">
            <thead className="bg-surface-sunken text-ink">
              <tr>
                <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">Client</th>
                <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">Country</th>
                <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">City</th>
                <th scope="col" className="h-8 border-b border-rule px-3 text-right font-semibold">Installations</th>
              </tr>
            </thead>
            <tbody>
              {clients.data.map((c) => (
                <tr key={c.id} className="h-10 border-b border-rule last:border-b-0 hover:bg-action-tint">
                  <td className="px-3 font-semibold">
                    <Link to={`/clients/${c.id}`} className="text-ink hover:underline">{c.legalName}</Link>
                  </td>
                  <td className="px-3 text-ink">{countryName(c.countryCode)}</td>
                  <td className="px-3 text-ink">{c.city}</td>
                  <td className="px-3 text-right text-ink tabular-nums">{c.installationCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

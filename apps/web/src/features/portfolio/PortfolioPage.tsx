import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/States';

// Design system 6.1. The client table arrives with M2.
export function PortfolioPage() {
  return (
    <div className="p-6">
      <PageHeader title="Portfolio" description="All clients and what needs attention today." />
      <EmptyState message="No clients yet. Clients you are assigned to appear here once they are added." />
    </div>
  );
}

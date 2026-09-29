import type { PeriodStatus } from '@cbam/shared';
import { ChevronRight } from 'lucide-react';
import { StatusBadge } from '@/components/StatusBadge';

export interface WorkContext {
  client: string;
  installation?: string;
  period?: { label: string; status: PeriodStatus };
}

/**
 * Design system 4: persistent inside a client — client › installation › period + status.
 * Crumbs become switchers when M2/M3 provide the lists.
 */
export function ContextBar({ context }: { context: WorkContext }) {
  const crumbs = [context.client, context.installation, context.period?.label].filter(Boolean) as string[];
  return (
    <nav aria-label="Current context" className="flex h-12 items-center gap-2 border-b border-rule bg-surface px-6">
      <ol className="flex items-center gap-2 text-body">
        {crumbs.map((c, i) => (
          <li key={c} className="flex items-center gap-2">
            {i > 0 && <ChevronRight aria-hidden className="size-4 text-ink-muted" strokeWidth={1.5} />}
            <span className={i === crumbs.length - 1 ? 'font-semibold' : undefined}>{c}</span>
          </li>
        ))}
      </ol>
      {context.period && <StatusBadge status={context.period.status} className="ml-2" />}
    </nav>
  );
}

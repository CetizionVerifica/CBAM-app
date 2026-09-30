import { AUDIT_MODULES, AUDIT_MODULE_LABELS, type AuditEntry, type AuditModule, type UserSummary, can } from '@cbam/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/Button';
import { Field, SelectField } from '@/components/Field';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useClients } from '@/features/registry/queries';
import { api } from '@/lib/api';
import { formatMoment } from '@/lib/format';
import { useMe } from '@/lib/session';

const OP_LABEL: Record<AuditEntry['op'], string> = { INSERT: 'Created', UPDATE: 'Changed', DELETE: 'Deleted' };

/** "public.installation" → "Installation". */
const tableLabel = (table: string) => {
  const name = table.split('.').pop() ?? table;
  return name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' ');
};

/** A logged value as text: strings as they are, everything else as JSON; empty as a dash. */
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Local calendar day → the instant it starts, so "from 3 Oct" means 3 Oct where the user is.
 * `end` gives the start of the next day, for an inclusive "to" date.
 */
const dayStart = (day: string, end = false) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + (end ? 1 : 0)).toISOString();
};

/**
 * Audit trail (M13-R5, R6; design system 6.11): newest first; who, when, which record, and
 * each changed field with its old and new value side by side. Filters by client, module,
 * record and date range; export to CSV with the same filters.
 */
export function AuditTrailPage() {
  const [search, setSearch] = useSearchParams();
  const clients = useClients();
  const me = useMe().data!;
  // The user filter lists the users this role may list (M1); reviewers filter by client instead.
  const users = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await api.get<{ users: UserSummary[] }>('/users')).users,
    enabled: can(me.user.role, 'users.list'),
  });
  const [recordDraft, setRecordDraft] = useState(search.get('recordId') ?? '');
  const filters = {
    clientId: search.get('clientId') ?? '',
    userId: search.get('userId') ?? '',
    module: (search.get('module') ?? '') as '' | AuditModule,
    recordId: search.get('recordId') ?? '',
    from: search.get('from') ?? '',
    to: search.get('to') ?? '',
  };
  const params = new URLSearchParams(
    Object.entries({
      clientId: filters.clientId,
      userId: filters.userId,
      module: filters.module,
      recordId: filters.recordId,
      from: filters.from && dayStart(filters.from),
      to: filters.to && dayStart(filters.to, true),
    }).filter((e): e is [string, string] => !!e[1]),
  );

  const set = (key: string, value: string) => {
    const p = new URLSearchParams(search);
    if (value) p.set(key, value);
    else p.delete(key);
    setSearch(p, { replace: true });
  };

  const trail = useInfiniteQuery({
    queryKey: ['audit', params.toString()],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      if (pageParam) p.set('before', String(pageParam));
      return api.get<{ entries: AuditEntry[]; next: number | null }>(`/audit?${p}`);
    },
    getNextPageParam: (last) => last.next,
  });
  const entries = trail.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <div className="p-6">
      <PageHeader
        title="Audit trail"
        description="Every change to the data, newest first: who made it, when, and the old and new values."
        actions={
          <a
            href={`/api/v1/audit.csv?${params}`}
            className="inline-flex h-9 items-center gap-2 rounded-button border border-rule-strong bg-surface px-4 text-body font-semibold text-ink hover:bg-surface-sunken"
          >
            <Download aria-hidden className="size-4" strokeWidth={1.5} /> Export CSV
          </a>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-60">
          <SelectField
            label="Client"
            value={filters.clientId}
            onChange={(e) => set('clientId', e.target.value)}
            options={[{ value: '', label: 'All clients' }, ...(clients.data ?? []).map((c) => ({ value: c.id, label: c.legalName }))]}
          />
        </div>
        {users.data && (
          <div className="w-56">
            <SelectField
              label="User"
              value={filters.userId}
              onChange={(e) => set('userId', e.target.value)}
              options={[{ value: '', label: 'All users' }, ...users.data.map((u) => ({ value: u.id, label: u.displayName }))]}
            />
          </div>
        )}
        <div className="w-56">
          <SelectField
            label="Module"
            value={filters.module}
            onChange={(e) => set('module', e.target.value)}
            options={[
              { value: '', label: 'All modules' },
              ...(Object.keys(AUDIT_MODULES) as AuditModule[]).map((m) => ({ value: m, label: AUDIT_MODULE_LABELS[m] })),
            ]}
          />
        </div>
        <div className="w-40">
          <Field label="From" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
        </div>
        <div className="w-40">
          <Field label="To" type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            set('recordId', recordDraft.trim());
          }}
        >
          <div className="w-72">
            <Field label="Record ID" value={recordDraft} onChange={(e) => setRecordDraft(e.target.value)} placeholder="Paste a record ID" />
          </div>
          <Button type="submit">Filter</Button>
        </form>
      </div>

      {trail.isPending ? (
        <SkeletonRows rows={8} />
      ) : trail.isError ? (
        <ErrorState message={trail.error.message} actions={<Button onClick={() => trail.refetch()}>Try again</Button>} />
      ) : entries.length === 0 ? (
        <EmptyState message="No changes match these filters." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
            <table className="w-full text-left text-small">
              <thead className="bg-surface-sunken text-ink">
                <tr>
                  {['Time', 'User', 'Change', 'Record', 'Field', 'Old value', 'New value'].map((h) => (
                    <th key={h} scope="col" className="h-8 border-b border-rule px-3 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const changes = e.op === 'UPDATE' ? e.changes : [];
                  const rows = Math.max(changes.length, 1);
                  return changes.length > 0 ? (
                    changes.map((c, i) => <AuditRow key={`${e.id}-${c.field}`} entry={e} change={c} first={i === 0} span={rows} />)
                  ) : (
                    <AuditRow key={e.id} entry={e} first span={1} />
                  );
                })}
              </tbody>
            </table>
          </div>
          {trail.hasNextPage && (
            <div className="mt-4">
              <Button onClick={() => trail.fetchNextPage()} disabled={trail.isFetchingNextPage}>
                {trail.isFetchingNextPage ? 'Loading…' : 'Show older changes'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AuditRow({ entry: e, change, first, span }: { entry: AuditEntry; change?: AuditEntry['changes'][number]; first: boolean; span: number }) {
  return (
    <tr className="border-b border-rule align-top last:border-b-0">
      {first && (
        <>
          <td rowSpan={span} className="px-3 py-2 whitespace-nowrap tabular-nums text-ink">{formatMoment(e.occurredAt)}</td>
          <td rowSpan={span} className="px-3 py-2 text-ink">
            {e.actorName ?? 'A user you cannot see'}
            {e.actorRole && <span className="block text-ink-muted">{e.actorRole.replace('_', ' ')}</span>}
          </td>
          <td rowSpan={span} className="px-3 py-2 text-ink">
            {e.action ?? OP_LABEL[e.op]}
            {e.reason && <span className="block text-ink-muted">“{e.reason}”</span>}
          </td>
          <td rowSpan={span} className="px-3 py-2 text-ink">
            {tableLabel(e.table)}
            <span className="block font-mono text-caption text-ink-muted">{e.recordId}</span>
          </td>
        </>
      )}
      {change ? (
        <>
          <td className="px-3 py-2 font-mono text-caption text-ink">{change.field}</td>
          <td className="max-w-64 px-3 py-2 break-words text-ink-muted line-through decoration-ink-muted/60">{show(change.old)}</td>
          <td className="max-w-64 bg-action-tint px-3 py-2 break-words text-ink">{show(change.new)}</td>
        </>
      ) : (
        <td colSpan={3} className="px-3 py-2 text-ink-muted">{OP_LABEL[e.op]} ({e.changes.length} fields)</td>
      )}
    </tr>
  );
}

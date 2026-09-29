import type { DatasetDiff, DiffDataset, DiffRow, LibraryDiff } from '@cbam/shared';
import { Minus, Pencil, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';

const DATASET_LABELS: Record<DiffDataset, string> = {
  factors: 'Factors',
  cn_codes: 'CN codes',
  goods_categories: 'Goods categories',
  routes: 'Production routes',
  precursors: 'Relevant precursors',
  qualifying_parameters: 'Qualifying parameters',
};

const FIELD_LABELS: Record<string, string> = {
  value: 'Value',
  unit: 'Unit',
  validFrom: 'Valid from',
  validTo: 'Valid to',
  plausibleMin: 'Plausible from',
  plausibleMax: 'Plausible to',
  source: 'Source',
  notes: 'Notes',
  description: 'Description',
  goodsCategory: 'Goods category',
  name: 'Name',
  indirectRelevantDefinitive: 'Indirect emissions count (definitive)',
  indirectRelevantTransitional: 'Indirect emissions count (transitional)',
};

const MAX_ROWS = 50;

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

/** Added, changed and removed counts per dataset, then the rows (design system 6.12). */
export function DiffSummary({ diff }: { diff: DatasetDiff }) {
  return (
    <ul className="flex gap-4 text-small text-ink">
      <li className="inline-flex items-center gap-1"><Plus aria-hidden className="size-3.5 text-ok" strokeWidth={1.5} /><span className="tabular-nums">{diff.added.length}</span> added</li>
      <li className="inline-flex items-center gap-1"><Pencil aria-hidden className="size-3.5 text-warn" strokeWidth={1.5} /><span className="tabular-nums">{diff.changed.length}</span> changed</li>
      <li className="inline-flex items-center gap-1"><Minus aria-hidden className="size-3.5 text-critical" strokeWidth={1.5} /><span className="tabular-nums">{diff.removed.length}</span> removed</li>
    </ul>
  );
}

export function DatasetDiffTable({ diff }: { diff: DatasetDiff }) {
  const rows: { type: 'Added' | 'Changed' | 'Removed'; row: DiffRow }[] = [
    ...diff.added.map((row) => ({ type: 'Added' as const, row })),
    ...diff.changed.map((row) => ({ type: 'Changed' as const, row })),
    ...diff.removed.map((row) => ({ type: 'Removed' as const, row })),
  ];
  if (rows.length === 0) return <p className="text-small text-ink-muted">No differences.</p>;
  return (
    <div className="max-h-72 overflow-y-auto rounded-panel border border-rule">
      <table className="w-full text-left text-small">
        <thead className="sticky top-0 bg-surface-sunken text-ink">
          <tr>
            <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">Change</th>
            <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">Entry</th>
            <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_ROWS).map(({ type, row }) => (
            <tr key={`${type}-${row.key}`} className="border-b border-rule align-top last:border-b-0">
              <td className="px-3 py-2 whitespace-nowrap text-ink">{type}</td>
              <td className="px-3 py-2 text-ink">{row.label}</td>
              <td className="px-3 py-2 text-ink">
                {type === 'Changed'
                  ? row.fields!.map((f) => (
                      <div key={f}>
                        {FIELD_LABELS[f] ?? f}: <span className="text-ink-muted line-through">{show(row.before?.[f])}</span> → {show(row.after?.[f])}
                      </div>
                    ))
                  : row.after?.value !== undefined || row.before?.value !== undefined
                    ? `${show((row.after ?? row.before)?.value)} ${show((row.after ?? row.before)?.unit)}`
                    : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <p className="border-t border-rule px-3 py-2 text-small text-ink-muted">
          Showing the first {MAX_ROWS} of {rows.length} differences.
        </p>
      )}
    </div>
  );
}

export function LibraryDiffView({ diff }: { diff: LibraryDiff }) {
  const datasets = Object.keys(diff) as DiffDataset[];
  if (datasets.length === 0) return <p className="text-body text-ink-muted">This version has no changes from the one it is based on.</p>;
  return (
    <div className="flex flex-col gap-4">
      {datasets.map((ds) => (
        <section key={ds} className={cn('flex flex-col gap-2')}>
          <div className="flex items-center justify-between">
            <h3 className="text-h3 font-semibold text-ink">{DATASET_LABELS[ds]}</h3>
            <DiffSummary diff={diff[ds]!} />
          </div>
          <DatasetDiffTable diff={diff[ds]!} />
        </section>
      ))}
    </div>
  );
}

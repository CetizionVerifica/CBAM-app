import {
  Decimal,
  type GoodsCategoryEntry,
  LibrarySettingsPatch,
  type LibraryVersionSummary,
  type QualifyingParameterDef,
  QualifyingParametersRequest,
} from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field } from '@/components/Field';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { ApiError, api } from '@/lib/api';
import { formatExact } from '@/lib/format';
import { libraryKeys, useCnCodes, useGoods, useLibrarySettings, useTemplates } from './queries';

const th = 'h-8 border-b border-rule px-3 font-semibold whitespace-nowrap';

const SECTOR_LABELS: Record<string, string> = {
  cement: 'Cement',
  iron_steel: 'Iron and steel',
  aluminium: 'Aluminium',
  fertilisers: 'Fertilisers',
  hydrogen: 'Hydrogen',
  electricity: 'Electricity',
};

const SECTOR_TOKEN: Record<string, string> = {
  cement: 'bg-[var(--sector-cement)]',
  iron_steel: 'bg-[var(--sector-iron-steel)]',
  aluminium: 'bg-[var(--sector-aluminium)]',
  fertilisers: 'bg-[var(--sector-fertilisers)]',
  hydrogen: 'bg-[var(--sector-hydrogen)]',
  electricity: 'bg-[var(--sector-electricity)]',
};

function Sector({ sector }: { sector: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink">
      <span aria-hidden className={`inline-block size-2 rounded-full ${SECTOR_TOKEN[sector] ?? 'bg-rule-strong'}`} />
      {SECTOR_LABELS[sector] ?? sector}
    </span>
  );
}

/** CN codes in a version, searchable by code or description. */
export function CnCodesTab({ version }: { version: LibraryVersionSummary }) {
  const cn = useCnCodes(version.id);
  const goods = useGoods(version.id);
  const [q, setQ] = useState('');
  const names = useMemo(() => new Map((goods.data ?? []).map((g) => [g.code, g.name])), [goods.data]);

  if (cn.isPending) return <SkeletonRows rows={8} />;
  if (cn.isError) return <ErrorState message={cn.error.message} />;
  if (cn.data.length === 0) return <EmptyState message={`Version ${version.code} has no CN codes. Import the CN-code list into a draft.`} />;

  const needle = q.trim().toLowerCase().replace(/\s+/g, '');
  const rows = needle
    ? cn.data.filter((c) => c.code.includes(needle) || c.description.toLowerCase().includes(q.trim().toLowerCase()))
    : cn.data;

  return (
    <>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="w-80">
          <Field label="Find a CN code" placeholder="Code or description" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <p className="text-small text-ink-muted">
          <span className="tabular-nums">{rows.length}</span> of <span className="tabular-nums">{cn.data.length}</span> codes
        </p>
      </div>
      {rows.length === 0 ? (
        <EmptyState message="No CN code matches. Check the digits or search the description." />
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-panel border border-rule bg-surface">
          <table className="w-full text-left font-condensed text-small">
            <thead className="sticky top-0 bg-surface-sunken text-ink">
              <tr>
                <th scope="col" className={th}>CN code</th>
                <th scope="col" className={th}>Description</th>
                <th scope="col" className={th}>Aggregated goods category</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.code} className="border-b border-rule align-top last:border-b-0">
                  <td className="px-3 py-2 font-mono whitespace-nowrap text-ink">{c.code.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1 $2 $3')}</td>
                  <td className="px-3 py-2 text-ink">{c.description}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink">{names.get(c.goodsCategoryCode) ?? c.goodsCategoryCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Regulatory configuration (M4-R7): which goods count indirect emissions, routes, relevant
 * precursors and qualifying parameters. Editable only in a draft by the platform admin.
 */
export function GoodsTab({ version, editable }: { version: LibraryVersionSummary; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const goods = useGoods(version.id);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GoodsCategoryEntry | null>(null);
  const [editingParams, setEditingParams] = useState<GoodsCategoryEntry | null>(null);

  if (goods.isPending) return <SkeletonRows rows={8} />;
  if (goods.isError) return <ErrorState message={goods.error.message} />;
  if (goods.data.length === 0) return <EmptyState message={`Version ${version.code} has no goods categories.`} />;
  const names = new Map(goods.data.map((g) => [g.code, g.name]));
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: libraryKeys.goods(version.id) }), qc.invalidateQueries({ queryKey: libraryKeys.diff(version.id) })]);

  const toggle = async (g: GoodsCategoryEntry, field: 'indirectRelevantDefinitive' | 'indirectRelevantTransitional', value: boolean) => {
    setError(null);
    try {
      await api.patch(`/library/goods-categories/${g.id}`, { [field]: value });
      await refresh();
      toast('Goods category saved');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  const Flag = ({ g, field }: { g: GoodsCategoryEntry; field: 'indirectRelevantDefinitive' | 'indirectRelevantTransitional' }) =>
    editable ? (
      <input
        type="checkbox"
        className="size-4 accent-[var(--action)]"
        aria-label={`${g.name}: indirect emissions count (${field === 'indirectRelevantDefinitive' ? 'definitive' : 'transitional'} period)`}
        checked={g[field]}
        onChange={(e) => toggle(g, field, e.target.checked)}
      />
    ) : (
      <span className="text-ink">{g[field] ? 'Yes' : 'No'}</span>
    );

  return (
    <>
      {error && <div className="mb-3"><ErrorState message={error} /></div>}
      <ToleranceSetting version={version} editable={editable} />
      <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
        <table className="w-full text-left font-condensed text-small">
          <thead className="bg-surface-sunken text-ink">
            <tr>
              <th scope="col" className={th}>Aggregated goods category</th>
              <th scope="col" className={th}>Sector</th>
              <th scope="col" className={th}>Unit</th>
              <th scope="col" className={th}>Indirect counts (definitive)</th>
              <th scope="col" className={th}>Indirect counts (transitional)</th>
              <th scope="col" className={th}>Production routes</th>
              <th scope="col" className={th}>Relevant precursors</th>
              <th scope="col" className={th}>Qualifying parameters</th>
            </tr>
          </thead>
          <tbody>
            {goods.data.map((g) => (
              <tr key={g.code} className="border-b border-rule align-top last:border-b-0">
                <td className="px-3 py-2 font-semibold text-ink">{g.name}</td>
                <td className="px-3 py-2 whitespace-nowrap"><Sector sector={g.sector} /></td>
                <td className="px-3 py-2 text-ink">{g.unit}</td>
                <td className="px-3 py-2"><Flag g={g} field="indirectRelevantDefinitive" /></td>
                <td className="px-3 py-2"><Flag g={g} field="indirectRelevantTransitional" /></td>
                <td className="px-3 py-2 text-ink">{g.routeRelevant ? g.routes.map((r) => r.name).join('; ') : 'All production routes'}</td>
                <td className="px-3 py-2 text-ink">
                  {g.precursors.length === 0
                    ? 'None'
                    : g.precursors.map((p) => `${names.get(p.precursorCode) ?? p.precursorCode}${p.routeCode ? ` (${g.routes.find((r) => r.code === p.routeCode)?.name ?? p.routeCode} only)` : ''}`).join('; ')}
                  {editable && (
                    <div>
                      <Button variant="quiet" className="h-7 px-0" onClick={() => setEditing(g)}>Edit precursors</Button>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-ink">
                  {g.qualifyingParameters.length === 0 ? (
                    '—'
                  ) : (
                    <ul>
                      {g.qualifyingParameters.map((q) => (
                        <li key={q.position}>
                          {q.name} <span className="text-ink-muted">({describeParam(q)})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {editable && (
                    <div>
                      <Button variant="quiet" className="h-7 px-0" onClick={() => setEditingParams(g)}>Edit qualifying parameters</Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editingParams && (
        <QualifyingParametersDialog
          category={editingParams}
          onClose={() => setEditingParams(null)}
          onSaved={async () => {
            await refresh();
            toast('Qualifying parameters saved');
            setEditingParams(null);
          }}
        />
      )}
      {editing && (
        <PrecursorsDialog
          category={editing}
          all={goods.data}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            toast('Relevant precursors saved');
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** Relevant precursors for all routes of a category (route-specific ones are kept as they are). */
function PrecursorsDialog({ category, all, onClose, onSaved }: { category: GoodsCategoryEntry; all: GoodsCategoryEntry[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const routeSpecific = category.precursors.filter((p) => p.routeCode !== null);
  const [chosen, setChosen] = useState(new Set(category.precursors.filter((p) => p.routeCode === null).map((p) => p.precursorCode)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/library/goods-categories/${category.id}/precursors`, {
        precursors: [...[...chosen].map((c) => ({ routeCode: null, precursorCode: c })), ...routeSpecific],
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Relevant precursors — ${category.name}`} description="Precursors whose embedded emissions count for this category on every route.">
      <div className="flex flex-col gap-4">
        <fieldset className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
          <legend className="sr-only">Precursor categories</legend>
          {all
            .filter((g) => g.code !== category.code)
            .map((g) => (
              <label key={g.code} className="flex items-center gap-2 text-body text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--action)]"
                  checked={chosen.has(g.code)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(g.code);
                    else next.delete(g.code);
                    setChosen(next);
                  }}
                />
                {g.name}
              </label>
            ))}
        </fieldset>
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={save}>Save precursors</Button>
        </div>
      </div>
    </Dialog>
  );
}

const KIND_LABEL = { number: 'number', text: 'text', choice: 'choice' } as const;
const DIMENSION_LABEL = { fraction: '%', mass_ratio: 't/t' } as const;

/** "required, number in %" — what M5 asks for (M5-R4, D18). */
const describeParam = (q: QualifyingParameterDef) =>
  `${q.required ? 'required' : 'optional'}, ${KIND_LABEL[q.valueKind]}${q.dimension ? ` in ${DIMENSION_LABEL[q.dimension]}` : ''}${q.choices ? `: ${q.choices.join(', ')}` : ''}`;

const percentOf = (fraction: string) => formatExact(new Decimal(fraction).times(100).toString());

/** Production balance tolerance of a version (M5-R3, D19), shown and entered as % of the activity level. */
function ToleranceSetting({ version, editable }: { version: LibraryVersionSummary; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useLibrarySettings(version.id);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (settings.isPending) return <div className="mb-3"><SkeletonRows rows={1} /></div>;
  if (settings.isError) return <div className="mb-3"><ErrorState message={settings.error.message} /></div>;
  const save = async () => {
    setError(null);
    const fraction = /^\d+(\.\d+)?$/.test(value ?? '') ? new Decimal(value!).div(100).toString() : 'x';
    const parsed = LibrarySettingsPatch.safeParse({ productionBalanceTolerance: fraction });
    if (!parsed.success) return setError('Enter a percentage between 0 and 20 %.');
    try {
      await api.patch(`/library/versions/${version.id}/settings`, parsed.data);
      await Promise.all([qc.invalidateQueries({ queryKey: libraryKeys.settings(version.id) }), qc.invalidateQueries({ queryKey: libraryKeys.diff(version.id) })]);
      setValue(null);
      toast('Library settings saved');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3 text-body text-ink">
      {value === null ? (
        <p>
          Production balance tolerance:{' '}
          <span className="tabular-nums font-semibold">{percentOf(settings.data.productionBalanceTolerance)}</span> <span className="text-ink-muted">% of the activity level</span>
          {editable && (
            <Button variant="quiet" className="ml-2 h-7" onClick={() => setValue(percentOf(settings.data.productionBalanceTolerance))}>Edit tolerance</Button>
          )}
        </p>
      ) : (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="w-48">
            <Field label="Production balance tolerance (%)" inputMode="decimal" className="text-right tabular-nums" value={value} error={error ?? undefined} onChange={(e) => setValue(e.target.value)} />
          </div>
          <Button onClick={() => setValue(null)}>Cancel</Button>
          <Button type="submit" variant="primary">Save tolerance</Button>
        </form>
      )}
    </div>
  );
}

type ParamRow = { position: string; name: string; required: boolean; valueKind: QualifyingParameterDef['valueKind']; dimension: string; choices: string };

/** Qualifying parameters of a category in a draft (D18): position, name, required, kind. */
function QualifyingParametersDialog({ category, onClose, onSaved }: { category: GoodsCategoryEntry; onClose: () => void; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<ParamRow[]>(() =>
    category.qualifyingParameters.map((q) => ({
      position: String(q.position),
      name: q.name,
      required: q.required,
      valueKind: q.valueKind,
      dimension: q.dimension ?? 'fraction',
      choices: q.choices?.join('; ') ?? '',
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<ParamRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    const body = {
      parameters: rows.map((r) => ({
        position: Number(r.position),
        name: r.name,
        required: r.required,
        valueKind: r.valueKind,
        dimension: r.valueKind === 'number' ? r.dimension : null,
        choices: r.valueKind === 'choice' ? r.choices.split(';').map((c) => c.trim()).filter(Boolean) : null,
      })),
    };
    const parsed = QualifyingParametersRequest.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      return setError(`${typeof i.path[1] === 'number' ? `Row ${i.path[1] + 1}: ` : ''}${i.message}`);
    }
    setBusy(true);
    setError(null);
    try {
      await api.put(`/library/goods-categories/${category.id}/qualifying-parameters`, parsed.data);
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };
  const input = 'h-9 rounded-input border border-rule-strong bg-surface px-2 text-body text-ink';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Qualifying parameters — ${category.name}`} description="Position is the column in the template's Summary_Products for this category. Required ones must be filled before a process is complete.">
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        {rows.map((r, i) => (
          <fieldset key={i} className="flex flex-col gap-2 border-b border-rule pb-3">
            <legend className="sr-only">Parameter {i + 1}</legend>
            <div className="flex gap-2">
              <input aria-label="Position" inputMode="numeric" className={`${input} w-14 text-right tabular-nums`} value={r.position} onChange={(e) => set(i, { position: e.target.value })} />
              <input aria-label="Name" className={`${input} flex-1`} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-body text-ink">
                <input type="checkbox" className="size-4 accent-[var(--action)]" checked={r.required} onChange={(e) => set(i, { required: e.target.checked })} />
                Required
              </label>
              <select aria-label="Kind of value" className={input} value={r.valueKind} onChange={(e) => set(i, { valueKind: e.target.value as ParamRow['valueKind'] })}>
                <option value="number">Number</option>
                <option value="text">Text</option>
                <option value="choice">Choice</option>
              </select>
              {r.valueKind === 'number' && (
                <select aria-label="Dimension" className={input} value={r.dimension} onChange={(e) => set(i, { dimension: e.target.value })}>
                  <option value="fraction">% or fraction</option>
                  <option value="mass_ratio">t per t</option>
                </select>
              )}
              {r.valueKind === 'choice' && (
                <input aria-label="Choices, separated by semicolons" placeholder="Choice 1; Choice 2" className={`${input} flex-1`} value={r.choices} onChange={(e) => set(i, { choices: e.target.value })} />
              )}
              <Button variant="destructive" className="h-7" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          </fieldset>
        ))}
        {rows.length < 8 && (
          <div>
            <Button
              variant="quiet"
              onClick={() => setRows([...rows, { position: String(Math.max(0, ...rows.map((r) => Number(r.position) || 0)) + 1), name: '', required: true, valueKind: 'number', dimension: 'fraction', choices: '' }])}
            >
              Add parameter
            </Button>
          </div>
        )}
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={save}>Save qualifying parameters</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Official template versions the report generator can fill (read-only). */
export function TemplatesTab() {
  const templates = useTemplates();
  if (templates.isPending) return <SkeletonRows rows={2} />;
  if (templates.isError) return <ErrorState message={templates.error.message} />;
  if (templates.data.length === 0) return <EmptyState message="No template versions are registered." />;
  return (
    <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
      <table className="w-full text-left text-small">
        <thead className="bg-surface-sunken text-ink">
          <tr>
            <th scope="col" className={th}>Template version</th>
            <th scope="col" className={th}>Title</th>
            <th scope="col" className={th}>Released</th>
            <th scope="col" className={th}>File</th>
            <th scope="col" className={th}>SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {templates.data.map((t) => (
            <tr key={t.code} className="h-10 border-b border-rule last:border-b-0">
              <td className="px-3 font-semibold text-ink">{t.code}</td>
              <td className="px-3 text-ink">{t.title}</td>
              <td className="px-3 whitespace-nowrap text-ink tabular-nums">{t.releasedOn}</td>
              <td className="px-3 text-ink">{t.fileName}</td>
              <td className="px-3 font-mono text-ink" title={t.fileSha256}>{t.fileSha256.slice(0, 12)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

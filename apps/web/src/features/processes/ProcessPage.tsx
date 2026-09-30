import {
  type AffectedRecord,
  Decimal,
  PROCESS_RULES,
  type ProcessCheck,
  type ProcessDetail,
  type ProcessGood,
  can,
} from '@cbam/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PageHeader } from '@/components/PageHeader';
import { Amount, ProvenanceChip } from '@/components/QuantityInput';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { type Trace, TraceButton, TraceDrawer } from '@/components/TraceDrawer';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatExact, formatMoment } from '@/lib/format';
import { useMe } from '@/lib/session';
import { EvidencePanel } from '@/features/evidence/EvidencePanel';
import { useGoods } from '@/features/library/queries';
import { AddGoodDialog, AffectedDialog, SetupDialog, type SetupValues } from './ProcessDialogs';
import { GoodDataDialog, ProductionForm } from './ProcessForms';
import { CheckCounts, PeriodFrame, ProcessStatusBadge, SectorSwatch, usePeriodVersion } from './ProcessListPage';
import { affectedOf, processKeys, useProcess, useProcessList } from './queries';

const th = 'h-8 border-b border-rule px-3 font-semibold whitespace-nowrap';

type Pending =
  | { kind: 'setup' }
  | { kind: 'addGood' }
  | { kind: 'goodData'; good: ProcessGood }
  | { kind: 'deleteProcess' }
  | { kind: 'affected'; title: string; consequence: string; confirmLabel: string; affected: AffectedRecord[]; run: () => Promise<void> };

/** A number with its unit, as the balance shows it (base unit of the category). */
const Qty = ({ value, unit }: { value: string | null; unit: string }) =>
  value === null ? <span className="text-ink-muted">Not entered</span> : <span className="tabular-nums">{formatExact(value)} <span className="text-ink-muted">{unit}</span></span>;

const percent = (fraction: string) => `${formatExact(new Decimal(fraction).times(100).toString())} %`;

/** Process builder, one process (design system 6.4; M5-R1 to R6). */
export function ProcessPage() {
  const { processId = '' } = useParams();
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { periodId, period, version, versionQuery } = usePeriodVersion();
  const process = useProcess(processId);
  const list = useProcessList(version?.id ?? '');
  const library = useGoods(process.data?.libraryVersionId ?? '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [actionError, setActionError] = useState<{ message: string; checks?: ProcessCheck[] } | null>(null);

  if (period.isPending || process.isPending || (version && list.isPending)) {
    return (
      <div className="p-6">
        <SkeletonRows rows={10} />
      </div>
    );
  }
  const loadError = period.error ?? process.error ?? list.error;
  if (loadError || !period.data || !version || !process.data || !list.data) {
    return (
      <div className="p-6">
        <ErrorState
          message={loadError?.message ?? 'This process does not exist or you do not have access to it.'}
          actions={<Link className="text-body font-semibold text-action underline" to={`/periods/${periodId}/processes${versionQuery}`}>Open the process list</Link>}
        />
      </div>
    );
  }

  const p = process.data;
  const locked = list.data.locked;
  const canConfigure = can(me.user.role, 'processes.configure') && !locked;
  const canEnter = can(me.user.role, 'processes.enterData') && !locked;
  const unit = p.goodsCategory.unit;
  const sector = library.data?.find((c) => c.code === p.goodsCategory.code)?.sector;
  const required = p.qualifyingParameters.filter((q) => q.required);
  const footer = `Library ${list.data.libraryVersion.code}`;

  const update = (next: ProcessDetail) => {
    qc.setQueryData(processKeys.process(next.id), next);
    void qc.invalidateQueries({ queryKey: processKeys.ofVersion(next.periodVersionId) });
  };

  /** Sends once; if the API lists affected records, asks, then sends with confirmation (D22). */
  const withConfirmation = async (
    send: (confirm: boolean) => Promise<void>,
    ask: { title: string; consequence: string; confirmLabel: string },
  ) => {
    try {
      await send(false);
    } catch (e) {
      const affected = affectedOf(e);
      if (!affected) throw e;
      setPending({ kind: 'affected', ...ask, affected, run: () => send(true) });
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError({
        message: e instanceof ApiError ? e.message : 'Something went wrong. Try again.',
        checks: e instanceof ApiError && e.code === 'checks_open' ? (e.details as { checks: ProcessCheck[] }).checks : undefined,
      });
    }
  };

  // Field errors stay in the set-up dialog; affected records replace it with the confirmation.
  const saveSetup = (v: SetupValues) =>
    withConfirmation(
      async (confirm) => {
        const { process: next } = await api.patch<{ process: ProcessDetail }>(`/processes/${p.id}`, { ...v, confirm });
        update(next);
        setPending(null);
        toast('Process saved');
      },
      {
        title: 'Change the set-up of this process?',
        consequence: 'These records hold data and will be deleted. The deletions are recorded in the audit trail.',
        confirmLabel: 'Change set-up and delete records',
      },
    );

  const deleteProcess = async (confirm: boolean) => {
    await api.delete(`/processes/${p.id}${confirm ? '?confirm=true' : ''}`);
    qc.removeQueries({ queryKey: processKeys.process(p.id) });
    await qc.invalidateQueries({ queryKey: processKeys.ofVersion(p.periodVersionId) });
    toast('Process deleted');
    navigate(`/periods/${periodId}/processes${versionQuery}`);
  };

  const deleteGood = (g: ProcessGood) =>
    run(() =>
      withConfirmation(
        async (confirm) => {
          const { process: next } = await api.delete<{ process: ProcessDetail }>(`/process-goods/${g.id}${confirm ? '?confirm=true' : ''}`);
          update(next);
          setPending(null);
          toast('Good deleted');
        },
        { title: `Delete good ${g.cnCode}?`, consequence: 'Its quantities, qualifying parameters and evidence links will be deleted.', confirmLabel: 'Delete good' },
      ),
    );

  const markComplete = () =>
    run(async () => {
      const { process: next } = await api.post<{ process: ProcessDetail }>(`/processes/${p.id}/complete`);
      update(next);
      toast('Process marked complete');
    });

  // --- traces (design system 5.5) ---
  const b = p.balance;
  const alTrace: Trace = {
    title: `Activity level — ${p.name}`,
    result: <Qty value={b.activityLevel} unit={unit} />,
    formula: 'AL = Σ production per route',
    inputs: p.routes.map((r) => ({ label: r.routeName ? `Production by ${r.routeName}` : 'Production', value: <Amount amount={r.amount} />, source: r.amount?.source })),
    footer,
  };
  const goodsTrace: Trace = {
    title: `Goods produced for the market — ${p.name}`,
    result: <Qty value={b.goods} unit={unit} />,
    formula: 'Σ quantity produced per CN code',
    inputs: p.goods.map((g) => ({ label: `Good ${g.cnCode}${g.productName ? ` ${g.productName}` : ''}`, value: <Amount amount={g.produced} />, source: g.produced?.source })),
    footer,
  };
  const internalTrace: Trace = {
    title: `Consumed by other processes — ${p.name}`,
    result: <Qty value={b.internalUse} unit={unit} />,
    formula: 'Σ amount consumed per consuming process',
    inputs: p.internalUses.map((u) => ({ label: `Consumed by ${u.consumerName}`, value: <Amount amount={u.amount} />, source: u.amount?.source })),
    footer,
  };
  const balanceTrace: Trace = {
    title: `Production balance — ${p.name}`,
    result: <Qty value={b.difference} unit={unit} />,
    formula: 'Difference = AL − Σ goods − Σ internal use − non-CBAM',
    inputs: [
      { label: 'Activity level (AL)', value: <Qty value={b.activityLevel} unit={unit} />, source: 'Production per route' },
      ...p.goods.map((g) => ({ label: `Good ${g.cnCode}${g.productName ? ` ${g.productName}` : ''}`, value: <Amount amount={g.produced} />, source: g.produced?.source })),
      ...p.internalUses.map((u) => ({ label: `Consumed by ${u.consumerName}`, value: <Amount amount={u.amount} />, source: u.amount?.source })),
      { label: 'Consumed for non-CBAM goods', value: <Amount amount={p.nonCbam} />, source: p.nonCbam?.source },
      { label: 'Tolerance (share of AL)', value: percent(b.tolerance), source: footer },
    ],
    footer,
  };

  return (
    <PeriodFrame period={period.data} status={version.status} locked={locked}>
      <PageHeader
        title={`P${p.position} ${p.name}`}
        description={`${p.goodsCategory.name} · activity level in ${unit}`}
        actions={
          canConfigure && (
            <>
              <Button variant="destructive" onClick={() => setPending({ kind: 'deleteProcess' })}>Delete process</Button>
              <Button disabled={!library.data} onClick={() => setPending({ kind: 'setup' })}>Edit set-up</Button>
              {p.status !== 'complete' && <Button variant="primary" onClick={markComplete}>Mark process complete</Button>}
            </>
          )
        }
      />
      <p className="mb-4 flex flex-wrap items-center gap-3 text-small text-ink-muted">
        <Link className="font-semibold text-action underline" to={`/periods/${periodId}/processes${versionQuery}`}>All processes</Link>
        <ProcessStatusBadge status={p.status} />
        {p.completedAt && <span>Completed by {p.completedBy ?? 'a user you cannot see'} on <span className="tabular-nums">{formatMoment(p.completedAt)}</span></span>}
      </p>

      {actionError && (
        <div className="mb-4">
          <ErrorState message={actionError.message} actions={actionError.checks && <CheckList checks={actionError.checks} />} />
        </div>
      )}

      <section aria-labelledby="checks" className="mb-8">
        <div className="mb-3 flex items-center gap-3">
          <h2 id="checks" className="text-h2 font-semibold text-ink">Checks</h2>
          <CheckCounts {...p.openChecks} />
        </div>
        {p.checks.length === 0 ? (
          <p className="flex items-center gap-2 text-body text-ink">
            <CheckCircle2 aria-hidden className="size-4 text-ok" strokeWidth={1.5} />
            All checks pass. {p.status !== 'complete' && canConfigure ? 'The process can be marked complete.' : ''}
          </p>
        ) : (
          <CheckList checks={p.checks} />
        )}
      </section>

      <section aria-labelledby="setup" className="mb-8">
        <h2 id="setup" className="mb-3 text-h2 font-semibold text-ink">Set-up</h2>
        <dl className="grid max-w-[var(--form-max-width)] grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-body">
          <dt className="text-ink-muted">Aggregated goods category</dt>
          <dd className="flex items-center gap-2 text-ink"><SectorSwatch sector={sector} />{p.goodsCategory.name}</dd>
          <dt className="text-ink-muted">Production routes</dt>
          <dd className="text-ink">{p.routeRelevant ? p.routes.map((r) => r.routeName).join('; ') : 'None (not route-relevant)'}</dd>
          <dt className="text-ink-muted">Included precursor categories</dt>
          <dd className="text-ink">
            {p.includedCategories.length === 0
              ? 'None'
              : p.includedCategories
                  .map((c) => {
                    const routes = library.data?.find((x) => x.code === c.code)?.routes ?? [];
                    const names = c.routeCodes.map((r) => routes.find((x) => x.code === r)?.name ?? r);
                    return names.length ? `${c.name} (${names.join(', ')})` : c.name;
                  })
                  .join('; ')}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="production" className="mb-8">
        <h2 id="production" className="mb-3 text-h2 font-semibold text-ink">Production</h2>
        <ProductionForm
          key={`${p.id}:${p.routes.map((r) => r.id).join()}:${p.otherProcesses.length}`}
          process={p}
          editable={canEnter}
          onSave={async (body) => {
            const { process: next } = await api.put<{ process: ProcessDetail }>(`/processes/${p.id}/production`, body);
            update(next);
            toast('Production saved');
          }}
        />
      </section>

      <section aria-labelledby="balance" className="mb-8">
        <h2 id="balance" className="mb-3 text-h2 font-semibold text-ink">Production balance</h2>
        <div
          className={cn(
            'max-w-[var(--form-max-width)] rounded-panel border bg-surface p-4',
            b.withinTolerance === false ? 'border-warn' : 'border-rule',
          )}
        >
          <dl className="grid grid-cols-[1fr_max-content] gap-x-6 gap-y-1 text-body">
            <dt className="text-ink">Activity level</dt>
            <dd className="text-right"><TraceButton trace={alTrace} onOpen={setTrace}><Qty value={b.activityLevel} unit={unit} /></TraceButton></dd>
            <dt className="text-ink">Goods (produced for the market)</dt>
            <dd className="text-right"><TraceButton trace={goodsTrace} onOpen={setTrace}><Qty value={b.goods} unit={unit} /></TraceButton></dd>
            <dt className="text-ink">Consumed by other processes</dt>
            <dd className="text-right"><TraceButton trace={internalTrace} onOpen={setTrace}><Qty value={b.internalUse} unit={unit} /></TraceButton></dd>
            <dt className="text-ink">Consumed for non-CBAM goods</dt>
            <dd className="text-right"><Qty value={b.nonCbam} unit={unit} /></dd>
            <dt className="border-t border-rule pt-1 font-semibold text-ink">Difference</dt>
            <dd className="border-t border-rule pt-1 text-right font-semibold">
              <TraceButton trace={balanceTrace} onOpen={setTrace}><Qty value={b.difference} unit={unit} /></TraceButton>
            </dd>
          </dl>
          <p className="mt-2 flex items-center gap-2 text-small text-ink">
            {b.withinTolerance === null ? (
              <span className="text-ink-muted">The balance is checked once every amount is entered.</span>
            ) : b.withinTolerance ? (
              <><CheckCircle2 aria-hidden className="size-4 text-ok" strokeWidth={1.5} />Within the tolerance of {percent(b.tolerance)} of the activity level.</>
            ) : (
              <><AlertTriangle aria-hidden className="size-4 text-warn" strokeWidth={1.5} />Outside the tolerance of {percent(b.tolerance)} of the activity level.</>
            )}
          </p>
        </div>
      </section>

      <section aria-labelledby="goods" className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="goods" className="text-h2 font-semibold text-ink">Goods</h2>
          {canConfigure && p.goods.length > 0 && <Button onClick={() => setPending({ kind: 'addGood' })}>Add good</Button>}
        </div>
        {p.goods.length === 0 ? (
          <EmptyState
            message={canConfigure ? `No goods yet. Add the CN codes of ${p.goodsCategory.name} this process makes.` : 'No goods yet. A consultant adds the CN codes this process makes.'}
            actions={canConfigure && <Button variant="primary" onClick={() => setPending({ kind: 'addGood' })}>Add good</Button>}
          />
        ) : (
          <div className="overflow-x-auto rounded-panel border border-rule bg-surface">
            <table className="w-full text-left font-condensed text-small">
              <thead className="bg-surface-sunken text-ink">
                <tr>
                  <th scope="col" className={th}>CN code</th>
                  <th scope="col" className={th}>Description</th>
                  <th scope="col" className={th}>Product name</th>
                  <th scope="col" className={cn(th, 'text-right')}>Produced</th>
                  <th scope="col" className={cn(th, 'text-right')}>Sold to the EU</th>
                  <th scope="col" className={cn(th, 'text-right')}>Sold elsewhere</th>
                  <th scope="col" className={th}>Qualifying parameters</th>
                  <th scope="col" className={th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {p.goods.map((g) => {
                  const filled = required.filter((q) => g.parameters.some((v) => v.position === q.position)).length;
                  return (
                    <tr key={g.id} className="border-b border-rule align-top last:border-b-0">
                      <td className="px-3 py-2 font-mono whitespace-nowrap text-ink">{g.cnCode.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1 $2 $3')}</td>
                      <td className="max-w-80 px-3 py-2 text-ink">{g.cnDescription}</td>
                      <td className="px-3 py-2 text-ink">{g.productName ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <Amount amount={g.produced} />
                        {g.produced && <div><ProvenanceChip provenance={g.produced.provenance} /></div>}
                      </td>
                      <td className="px-3 py-2 text-right"><Amount amount={g.soldEu} /></td>
                      <td className="px-3 py-2 text-right"><Amount amount={g.soldOther} /></td>
                      <td className="px-3 py-2 whitespace-nowrap text-ink">
                        {required.length === 0 ? 'None required' : <span className="tabular-nums">{filled} of {required.length} required</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {canEnter && <Button variant="quiet" className="h-7" onClick={() => setPending({ kind: 'goodData', good: g })}>Enter data</Button>}
                        {canConfigure && <Button variant="destructive" className="h-7" onClick={() => deleteGood(g)}>Delete good</Button>}
                        {!canEnter && g.parameters.length > 0 && (
                          <span className="text-ink-muted">
                            {p.qualifyingParameters
                              .flatMap((d) => {
                                const v = g.parameters.find((x) => x.position === d.position);
                                if (!v) return [];
                                return [`${d.name}: ${v.text ?? `${formatExact(v.quantity!.value)} ${v.quantity!.unit}`}`];
                              })
                              .join('; ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <EvidencePanel clientId={p.clientId} installationId={p.installationId} recordType="production_process" recordId={p.id} locked={locked} />

      <TraceDrawer trace={trace} onClose={() => setTrace(null)} />

      {pending?.kind === 'setup' && library.data && (
        <SetupDialog title="Edit set-up" submitLabel="Save process" library={library.data} initial={p} onClose={() => setPending(null)} onSubmit={saveSetup} />
      )}
      {pending?.kind === 'addGood' && (
        <AddGoodDialog
          categoryName={p.goodsCategory.name}
          onClose={() => setPending(null)}
          onSubmit={async (v) => {
            const { process: next } = await api.post<{ process: ProcessDetail }>(`/processes/${p.id}/goods`, v);
            update(next);
            setPending(null);
            toast('Good added');
          }}
        />
      )}
      {pending?.kind === 'goodData' && (
        <GoodDataDialog
          process={p}
          good={pending.good}
          onClose={() => setPending(null)}
          onSave={async (body) => {
            const { process: next } = await api.put<{ process: ProcessDetail }>(`/process-goods/${pending.good.id}/data`, body);
            update(next);
            setPending(null);
            toast('Good data saved');
          }}
        />
      )}
      {pending?.kind === 'deleteProcess' && (
        <ConfirmDialog
          title={`Delete ${p.name}?`}
          consequence="The process and its routes are deleted. If it holds data, you will see the records first."
          confirmLabel="Delete process"
          onClose={() => setPending(null)}
          onConfirm={async () => {
            try {
              await deleteProcess(false);
            } catch (e) {
              const affected = affectedOf(e);
              if (!affected) throw e;
              setPending({
                kind: 'affected',
                title: `Delete ${p.name} and its data?`,
                consequence: 'These records are deleted with the process. The deletions are recorded in the audit trail.',
                confirmLabel: 'Delete process and data',
                affected,
                run: () => deleteProcess(true),
              });
            }
          }}
        />
      )}
      {pending?.kind === 'affected' && (
        <AffectedDialog
          title={pending.title}
          consequence={pending.consequence}
          affected={pending.affected}
          confirmLabel={pending.confirmLabel}
          onClose={() => setPending(null)}
          onConfirm={pending.run}
        />
      )}
    </PeriodFrame>
  );
}

/** Checks with rule ID and severity; icon and word, not colour alone (design system 10). */
function CheckList({ checks }: { checks: ProcessCheck[] }) {
  return (
    <ul className="flex max-w-[var(--form-max-width)] flex-col rounded-panel border border-rule bg-surface">
      {checks.map((c, i) => (
        <li key={`${c.ruleId}:${c.record.id}:${i}`} className="flex items-start gap-3 border-b border-rule px-4 py-2 last:border-b-0">
          <AlertTriangle aria-hidden className={cn('mt-0.5 size-4 shrink-0', c.severity === 'critical' ? 'text-critical' : 'text-warn')} strokeWidth={1.5} />
          <div className="flex flex-col">
            <span className="text-body text-ink">{c.message}</span>
            <span className="text-caption text-ink-muted">
              {c.severity === 'critical' ? 'Critical' : 'Warning'} · {c.ruleId} {PROCESS_RULES[c.ruleId]}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

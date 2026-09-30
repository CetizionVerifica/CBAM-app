import {
  GoodDataRequest,
  type ProcessDetail,
  type ProcessGood,
  ProductionRequest,
  type QualifyingParameterDef,
  categoryDimension,
  unitsFor,
} from '@cbam/shared';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, SelectField } from '@/components/Field';
import { type QuantityDraft, QuantityInput, draftFrom, draftToInput, emptyDraft } from '@/components/QuantityInput';
import { ErrorState } from '@/components/States';
import { ApiError } from '@/lib/api';
import { type Errors, issuesToErrors } from './ProcessDialogs';

/** Errors of one quantity group, from issues keyed by path ("routes.0.amount.unit"). */
export const quantityErrors = (errors: Errors, prefix: string) => ({
  value: errors[`${prefix}.value`] ?? errors[prefix],
  unit: errors[`${prefix}.unit`],
  source: errors[`${prefix}.source`],
  provenance: errors[`${prefix}.provenance`],
});

export const categoryUnits = (unit: string) => unitsFor(categoryDimension(unit));

/**
 * Production of the process (template D_Processes (a), (c), (d)): per route, consumed by other
 * processes, consumed for non-CBAM goods. Contributors enter it too (D21).
 */
export function ProductionForm({ process, editable, onSave }: { process: ProcessDetail; editable: boolean; onSave: (body: ProductionRequest) => Promise<void> }) {
  const unit = process.goodsCategory.unit;
  const units = categoryUnits(unit);
  const [routes, setRoutes] = useState(() => process.routes.map((r) => ({ routeId: r.id, draft: draftFrom(r.amount, unit) })));
  const [nonCbam, setNonCbam] = useState(() => draftFrom(process.nonCbam, unit));
  const [uses, setUses] = useState(() => process.internalUses.map((u) => ({ consumerProcessId: u.consumerProcessId, draft: draftFrom(u.amount, unit) })));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body = {
      routes: routes.map((r) => ({ routeId: r.routeId, amount: draftToInput(r.draft) })),
      nonCbam: draftToInput(nonCbam),
      internalUses: uses.map((u) => ({ consumerProcessId: u.consumerProcessId, amount: draftToInput(u.draft) })),
    };
    const parsed = ProductionRequest.safeParse(body);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues));
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await onSave(parsed.data);
    } catch (e) {
      if (e instanceof ApiError && e.issues.length) setErrors(issuesToErrors(e.issues));
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex max-w-[var(--form-max-width)] flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {routes.map((r, i) => {
        const row = process.routes.find((x) => x.id === r.routeId)!;
        return (
          <QuantityInput
            key={r.routeId}
            label={row.routeName ? `Production by ${row.routeName}` : 'Production'}
            required
            draft={r.draft}
            units={units}
            readOnly={!editable}
            errors={quantityErrors(errors, `routes.${i}.amount`)}
            onChange={(draft) => setRoutes(routes.map((x, j) => (j === i ? { ...x, draft } : x)))}
          />
        );
      })}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-h3 font-semibold text-ink">Consumed inside the installation</legend>
        {process.otherProcesses.length === 0 && uses.length === 0 && (
          <p className="text-small text-ink-muted">No other process in this period consumes this output.</p>
        )}
        {process.otherProcesses.map((o) => {
          const i = uses.findIndex((u) => u.consumerProcessId === o.id);
          return (
            <div key={o.id} className="flex flex-col gap-2">
              {editable && (
                <label className="flex items-center gap-2 text-body text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--action)]"
                    checked={i >= 0}
                    onChange={(e) =>
                      setUses(e.target.checked ? [...uses, { consumerProcessId: o.id, draft: emptyDraft(unit) }] : uses.filter((u) => u.consumerProcessId !== o.id))
                    }
                  />
                  {o.name} consumes this output
                </label>
              )}
              {i >= 0 && (
                <QuantityInput
                  label={`Consumed by ${o.name}`}
                  draft={uses[i]!.draft}
                  units={units}
                  readOnly={!editable}
                  errors={quantityErrors(errors, `internalUses.${i}.amount`)}
                  onChange={(draft) => setUses(uses.map((u, j) => (j === i ? { ...u, draft } : u)))}
                />
              )}
            </div>
          );
        })}
        <QuantityInput
          label="Consumed for non-CBAM goods"
          draft={nonCbam}
          units={units}
          readOnly={!editable}
          errors={quantityErrors(errors, 'nonCbam')}
          onChange={setNonCbam}
        />
      </fieldset>
      {formError && <ErrorState message={formError} />}
      {editable && (
        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            Save production
          </Button>
        </div>
      )}
    </form>
  );
}

type ParamDraft = { text: string; quantity: QuantityDraft };

const paramDraft = (def: QualifyingParameterDef, good: ProcessGood): ParamDraft => {
  const v = good.parameters.find((p) => p.position === def.position);
  const unit = def.dimension === 'mass_ratio' ? 't/t' : '%';
  return { text: v?.text ?? '', quantity: draftFrom(v?.quantity ?? null, unit) };
};

/** Quantities of one good and its qualifying parameters (spec 4.3, M5-R4, D18). */
export function GoodDataDialog({
  process,
  good,
  onSave,
  onClose,
}: {
  process: ProcessDetail;
  good: ProcessGood;
  onSave: (body: GoodDataRequest) => Promise<void>;
  onClose: () => void;
}) {
  const unit = process.goodsCategory.unit;
  const units = categoryUnits(unit);
  const [produced, setProduced] = useState(() => draftFrom(good.produced, unit));
  const [soldEu, setSoldEu] = useState(() => draftFrom(good.soldEu, unit));
  const [soldOther, setSoldOther] = useState(() => draftFrom(good.soldOther, unit));
  const [params, setParams] = useState(() => process.qualifyingParameters.map((d) => paramDraft(d, good)));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body = {
      produced: draftToInput(produced),
      soldEu: draftToInput(soldEu),
      soldOther: draftToInput(soldOther),
      parameters: process.qualifyingParameters.map((d, i) => ({
        position: d.position,
        text: d.valueKind === 'number' ? null : params[i]!.text.trim() || null,
        quantity: d.valueKind === 'number' ? draftToInput(params[i]!.quantity) : null,
      })),
    };
    const parsed = GoodDataRequest.safeParse(body);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues));
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await onSave(parsed.data);
    } catch (e) {
      if (e instanceof ApiError && e.issues.length) setErrors(issuesToErrors(e.issues));
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  const setParam = (i: number, patch: Partial<ParamDraft>) => setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Good ${good.cnCode}${good.productName ? ` — ${good.productName}` : ''}`} description={good.cnDescription}>
      <form
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <QuantityInput label="Quantity produced" required draft={produced} units={units} errors={quantityErrors(errors, 'produced')} onChange={setProduced} />
        <QuantityInput label="Sold to the EU" draft={soldEu} units={units} errors={quantityErrors(errors, 'soldEu')} onChange={setSoldEu} />
        <QuantityInput label="Sold to other markets" draft={soldOther} units={units} errors={quantityErrors(errors, 'soldOther')} onChange={setSoldOther} />
        {process.qualifyingParameters.length > 0 && (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-h3 font-semibold text-ink">Qualifying parameters</legend>
            {process.qualifyingParameters.map((d, i) => {
              const label = `${d.name}${d.required ? '' : ' (optional)'}`;
              if (d.valueKind === 'number') {
                return (
                  <QuantityInput
                    key={d.position}
                    label={d.name}
                    required={d.required}
                    draft={params[i]!.quantity}
                    units={unitsFor(d.dimension!)}
                    errors={quantityErrors(errors, `parameters.${i}.quantity`)}
                    onChange={(quantity) => setParam(i, { quantity })}
                  />
                );
              }
              if (d.valueKind === 'choice') {
                return (
                  <SelectField
                    key={d.position}
                    label={label}
                    value={params[i]!.text}
                    error={errors[`parameters.${i}.text`]}
                    options={[{ value: '', label: 'Not given' }, ...d.choices!.map((c) => ({ value: c, label: c }))]}
                    onChange={(e) => setParam(i, { text: (e.target as HTMLSelectElement).value })}
                  />
                );
              }
              return <Field key={d.position} label={label} value={params[i]!.text} error={errors[`parameters.${i}.text`]} onChange={(e) => setParam(i, { text: e.target.value })} />;
            })}
          </fieldset>
        )}
        {formError && <ErrorState message={formError} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Save good data
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

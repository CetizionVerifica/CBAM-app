import {
  type AffectedRecord,
  CreateProcessRequest,
  GoodInput,
  type GoodsCategoryEntry,
  type ProcessDetail,
} from '@cbam/shared';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field, SelectField } from '@/components/Field';
import { ErrorState } from '@/components/States';
import { ApiError } from '@/lib/api';
import { precursorsOf } from './queries';

export type Errors = Record<string, string>;

/** Zod or API issues keyed by their joined path ("routeCodes.0"). */
export const issuesToErrors = (issues: { path: PropertyKey[]; message: string }[]): Errors =>
  Object.fromEntries(issues.map((i) => [i.path.map(String).join('.'), i.message]));

/** The message for a field or anything below it ("routeCodes" matches "routeCodes.0"). */
export const errorAt = (errors: Errors, path: string) =>
  errors[path] ?? Object.entries(errors).find(([k]) => k.startsWith(`${path}.`))?.[1];

/**
 * M5-R5, R6 (D22): the API listed what a change would delete. The user sees every record
 * before confirming; nothing happens on cancel.
 */
export function AffectedDialog({
  title,
  consequence,
  affected,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  consequence: string;
  affected: AffectedRecord[];
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={consequence}>
      <div className="flex flex-col gap-4">
        {affected.length > 0 && (
          <ul aria-label="Records affected" className="max-h-60 overflow-y-auto rounded-input border border-rule">
            {affected.map((a) => (
              <li key={`${a.table}:${a.id}`} className="border-b border-rule px-3 py-2 text-small tabular-nums text-ink last:border-b-0">
                {a.label}
              </li>
            ))}
          </ul>
        )}
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="confirmDestructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Checks({
  legend,
  options,
  chosen,
  onChange,
  error,
}: {
  legend: string;
  options: { value: string; label: string }[];
  chosen: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-body font-semibold text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-body text-ink">
            <input
              type="checkbox"
              className="size-4 accent-[var(--action)]"
              checked={chosen.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((c) => c !== o.value))}
            />
            {o.label}
          </label>
        ))}
      </div>
      {error && <p className="text-small text-ink">{error}</p>}
    </fieldset>
  );
}

export interface SetupValues {
  name: string;
  goodsCategoryCode: string;
  routeCodes: string[];
  includedCategories: { code: string; routeCodes: string[] }[];
}

/**
 * Add a process or change its set-up (M5-R1, D16): the category from the pinned library,
 * routes filtered by category, included categories only among its relevant precursors.
 */
export function SetupDialog({
  title,
  submitLabel,
  library,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  library: GoodsCategoryEntry[];
  initial?: ProcessDetail;
  onSubmit: (v: SetupValues) => Promise<void>;
  onClose: () => void;
}) {
  const [v, setV] = useState<SetupValues>({
    name: initial?.name ?? '',
    goodsCategoryCode: initial?.goodsCategory.code ?? '',
    routeCodes: initial?.routes.flatMap((r) => (r.routeCode ? [r.routeCode] : [])) ?? [],
    includedCategories: initial?.includedCategories.map((c) => ({ code: c.code, routeCodes: c.routeCodes })) ?? [],
  });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byCode = new Map(library.map((c) => [c.code, c]));
  const main = byCode.get(v.goodsCategoryCode);
  const precursors = main ? [...precursorsOf(library, main.code)].map((c) => byCode.get(c)!).filter(Boolean) : [];

  const submit = async () => {
    const parsed = CreateProcessRequest.safeParse(v);
    const local: Errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (!v.goodsCategoryCode) local.goodsCategoryCode = 'Choose a goods category from the list.';
    if (main?.routeRelevant && v.routeCodes.length === 0) local.routeCodes = 'Choose at least one production route.';
    if (Object.keys(local).length) return setErrors(local);
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await onSubmit(v);
    } catch (e) {
      if (e instanceof ApiError && e.issues.length) setErrors(issuesToErrors(e.issues));
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description="Goods category, routes and precursor categories come from the library version this period uses.">
      <form
        className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Process name" value={v.name} error={errors.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <SelectField
          label="Aggregated goods category"
          value={v.goodsCategoryCode}
          error={errors.goodsCategoryCode}
          options={[{ value: '', label: 'Choose a category' }, ...library.map((c) => ({ value: c.code, label: c.name }))]}
          onChange={(e) => setV({ ...v, goodsCategoryCode: (e.target as HTMLSelectElement).value, routeCodes: [], includedCategories: [] })}
        />
        {main &&
          (main.routeRelevant ? (
            <Checks
              legend="Production routes"
              options={main.routes.map((r) => ({ value: r.code, label: r.name }))}
              chosen={v.routeCodes}
              error={errorAt(errors, 'routeCodes')}
              onChange={(routeCodes) => setV({ ...v, routeCodes })}
            />
          ) : (
            <p className="text-small text-ink-muted">{main.name} has no production routes: production is entered as one amount.</p>
          ))}
        {main && precursors.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body font-semibold text-ink">Included precursor categories</legend>
            <p className="text-small text-ink-muted">Relevant precursors made inside this process’s boundary. At most five.</p>
            {precursors.map((c) => {
              const inc = v.includedCategories.find((i) => i.code === c.code);
              return (
                <div key={c.code} className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-body text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--action)]"
                      checked={!!inc}
                      onChange={(e) =>
                        setV({
                          ...v,
                          includedCategories: e.target.checked
                            ? [...v.includedCategories, { code: c.code, routeCodes: [] }]
                            : v.includedCategories.filter((i) => i.code !== c.code),
                        })
                      }
                    />
                    {c.name}
                  </label>
                  {inc && c.routeRelevant && (
                    <div className="pl-6">
                      <Checks
                        legend={`Routes of ${c.name}`}
                        options={c.routes.map((r) => ({ value: r.code, label: r.name }))}
                        chosen={inc.routeCodes}
                        onChange={(routeCodes) =>
                          setV({ ...v, includedCategories: v.includedCategories.map((i) => (i.code === c.code ? { ...i, routeCodes } : i)) })
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {errorAt(errors, 'includedCategories') && <p className="text-small text-ink">{errorAt(errors, 'includedCategories')}</p>}
          </fieldset>
        )}
        {formError && <ErrorState message={formError} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** M5-R2: a CN code of the process's category; the API's message shows on the field (AT1). */
export function AddGoodDialog({ categoryName, onSubmit, onClose }: { categoryName: string; onSubmit: (v: GoodInput) => Promise<void>; onClose: () => void }) {
  const [cnCode, setCnCode] = useState('');
  const [productName, setProductName] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const parsed = GoodInput.safeParse({ cnCode, productName });
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues));
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await onSubmit(parsed.data);
    } catch (e) {
      if (e instanceof ApiError && e.issues.length) setErrors(issuesToErrors(e.issues));
      else setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add good" description={`A CN code of ${categoryName} that this process makes.`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="CN code" inputMode="numeric" placeholder="7601 10 00" value={cnCode} error={errors.cnCode} onChange={(e) => setCnCode(e.target.value)} />
        <Field
          label="Product name (optional)"
          hint="The name used with the importer, e.g. on invoices."
          value={productName}
          error={errors.productName}
          onChange={(e) => setProductName(e.target.value)}
        />
        {formError && <ErrorState message={formError} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Add good
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

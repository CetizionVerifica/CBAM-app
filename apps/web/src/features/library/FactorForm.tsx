import { FACTOR_KIND_LABELS, type FactorKind, FactorInput, OverrideInput, SEE_COMPONENTS, UNITS, unitsForKind } from '@cbam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/Button';
import { Field, SelectField } from '@/components/Field';
import { ErrorState } from '@/components/States';
import { applyServerError } from '@/lib/forms';
import { useCountries } from '@/lib/reference';

/** Form values are strings; empty strings become null and the year a number before the shared schema runs. */
export interface FactorFormValues {
  kind: FactorKind;
  subject: string;
  countryCode: string;
  region: string;
  year: string;
  component: string;
  value: string;
  unit: string;
  validFrom: string;
  validTo: string;
  plausibleMin: string;
  plausibleMax: string;
  source: string;
  notes: string;
  justification: string;
}

const toSchemaInput = (v: Record<string, unknown>) => ({
  ...v,
  countryCode: v.countryCode === '' ? null : v.countryCode,
  component: v.component === '' ? null : v.component,
  year: v.year === '' || v.year == null ? null : /^\d+$/.test(String(v.year)) ? Number(v.year) : v.year,
});

// The same shared schemas the API uses (G7), after the form-to-schema mapping above.
const factorSchema = z.preprocess((v) => toSchemaInput(v as Record<string, unknown>), FactorInput);
const overrideSchema = z.preprocess((v) => toSchemaInput(v as Record<string, unknown>), OverrideInput);

const blank = (kind: FactorKind): FactorFormValues => ({
  kind,
  subject: kind === 'grid_factor' ? 'electricity' : '',
  countryCode: '',
  region: '',
  year: '',
  component: kind === 'default_see' ? 'direct' : '',
  value: '',
  unit: unitsForKind(kind)[0]!,
  validFrom: '',
  validTo: '',
  plausibleMin: '',
  plausibleMax: '',
  source: '',
  notes: '',
  justification: '',
});

export const factorFormValues = (kind: FactorKind, f?: Partial<Record<keyof FactorFormValues, unknown>>): FactorFormValues => {
  const base = blank(kind);
  if (!f) return base;
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof FactorFormValues)[]) {
    if (f[k] != null) (out as Record<string, unknown>)[k] = String(f[k]);
  }
  return out;
};

const SUBJECT_HINT: Record<FactorKind, string> = {
  emission_factor: 'The fuel or material, like Natural gas.',
  ncv: 'The fuel, like Coking coal.',
  gwp: 'The gas, like N2O, CF4 or C2F6.',
  grid_factor: 'Usually “electricity”.',
  default_see: 'The 8-digit CN code, like 72081000.',
};

/**
 * Add or edit a library factor (M4-R1, R6, R8), or propose a client override (M4-R5,
 * `mode="override"`: no range or notes, a justification instead).
 */
export function FactorForm({
  mode,
  initial,
  kindLocked,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  mode: 'library' | 'override';
  initial: FactorFormValues;
  kindLocked: boolean;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const countries = useCountries();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<FactorFormValues>({
    resolver: zodResolver((mode === 'library' ? factorSchema : overrideSchema) as never),
    mode: 'onBlur',
    defaultValues: initial,
  });
  const kind = form.watch('kind');
  const err = (k: keyof FactorFormValues) => form.formState.errors[k]?.message;

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values as unknown as Record<string, unknown>);
    } catch (e) {
      setFormError(applyServerError(e, form.setError));
    }
  });

  const countryOptions = [
    { value: '', label: kind === 'grid_factor' ? 'Choose a country' : 'Any country' },
    ...(countries.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.code})` })),
  ];

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {formError && <ErrorState message={formError} />}
      <SelectField
        label="Kind"
        disabled={kindLocked}
        options={(Object.keys(FACTOR_KIND_LABELS) as FactorKind[]).map((k) => ({ value: k, label: FACTOR_KIND_LABELS[k] }))}
        error={err('kind')}
        {...form.register('kind', {
          onChange: (e) => {
            const k = (e.target as HTMLSelectElement).value as FactorKind;
            form.setValue('unit', unitsForKind(k)[0]!);
            form.setValue('component', k === 'default_see' ? 'direct' : '');
          },
        })}
      />
      <Field label="Applies to" hint={SUBJECT_HINT[kind]} error={err('subject')} {...form.register('subject')} />
      <div className="grid grid-cols-2 gap-4">
        <SelectField label={kind === 'grid_factor' ? 'Country' : 'Country (optional)'} options={countryOptions} error={err('countryCode')} {...form.register('countryCode')} />
        <Field label={kind === 'grid_factor' ? 'Year' : 'Year (optional)'} inputMode="numeric" error={err('year')} {...form.register('year')} />
      </div>
      {kind === 'grid_factor' && <Field label="Region (optional)" hint="Only where the country publishes regional grid factors." error={err('region')} {...form.register('region')} />}
      {kind === 'default_see' && (
        <SelectField
          label="Component"
          options={SEE_COMPONENTS.map((c) => ({ value: c, label: c === 'direct' ? 'Direct' : 'Indirect' }))}
          error={err('component')}
          {...form.register('component')}
        />
      )}
      <div className="grid grid-cols-[1fr_180px] gap-4">
        <Field label="Value" inputMode="decimal" className="text-right tabular-nums" error={err('value')} {...form.register('value')} />
        <SelectField label="Unit" options={unitsForKind(kind).map((u) => ({ value: u, label: UNITS[u].label || u }))} error={err('unit')} {...form.register('unit')} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Valid from" type="date" error={err('validFrom')} {...form.register('validFrom')} />
        <Field label="Valid to (optional)" type="date" error={err('validTo')} {...form.register('validTo')} />
      </div>
      {mode === 'library' && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Plausible from (optional)" inputMode="decimal" className="text-right tabular-nums" hint="Lower bound, in the same unit. Used by the plausibility checks." error={err('plausibleMin')} {...form.register('plausibleMin')} />
          <Field label="Plausible to (optional)" inputMode="decimal" className="text-right tabular-nums" hint="Upper bound, in the same unit." error={err('plausibleMax')} {...form.register('plausibleMax')} />
        </div>
      )}
      <Field label="Source" hint="Publication, table or legal reference the value comes from." error={err('source')} {...form.register('source')} />
      {mode === 'library' ? (
        <Field label="Notes (optional)" error={err('notes')} {...form.register('notes')} />
      ) : (
        <Field label="Justification" hint="Why this client needs its own value. The platform admin reads this before approving." error={err('justification')} {...form.register('justification')} />
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

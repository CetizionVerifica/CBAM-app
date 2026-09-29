import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { type FieldValues, type Path, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { cn } from '@/lib/cn';
import { applyServerError } from '@/lib/forms';
import { useCountries } from '@/lib/reference';
import { Button } from './Button';
import { ErrorState } from './States';

export interface FieldDef {
  name: string;
  label: string;
  kind?: 'text' | 'email' | 'tel' | 'country' | 'coordinate';
  required?: boolean;
  hint?: string;
  /** Spans both columns of the two-column form. */
  wide?: boolean;
}

export interface SectionDef {
  title: string;
  description?: string;
  fields: FieldDef[];
}

type Values = Record<string, string>;

/** null/undefined → '' for inputs; the shared schemas turn '' back into null. */
export const toFormValues = (record: Record<string, unknown> | undefined, sections: SectionDef[]): Values =>
  Object.fromEntries(sections.flatMap((s) => s.fields).map((f) => [f.name, (record?.[f.name] as string | null) ?? '']));

type Props = {
  sections: SectionDef[];
  schema: z.ZodType<FieldValues, Values>;
  values: Values;
} & (
  | { mode: 'create'; submitLabel: string; onSubmit: (values: FieldValues) => Promise<void>; onCancel?: () => void }
  | { mode: 'edit'; readOnly?: boolean; onSave: (patch: Record<string, string>) => Promise<void> }
);

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: Date } | { kind: 'error'; message: string };

/**
 * Two-column grouped form (design system 6.2; max 880 px). Create mode submits once;
 * edit mode autosaves each field on blur (design system 7) and shows the save state.
 * Validation runs on blur with the shared Zod schema, same messages as the API (G8).
 */
export function RecordForm(props: Props) {
  const { sections, schema, values } = props;
  const countries = useCountries();
  const [formError, setFormError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const saved = useRef<Values>(values);
  // Server updates refresh the form without touching fields the user is still editing.
  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    mode: 'onBlur',
    values,
    resetOptions: { keepDirtyValues: true },
  });
  useEffect(() => {
    saved.current = values;
  }, [values]);
  const readOnly = props.mode === 'edit' && props.readOnly;

  // On blur: send every field that differs from the last saved copy, once the whole record
  // is valid. Cross-field rules (UN/LOCODE vs country) can need two fields changed
  // together, so saving one field at a time could never get there.
  const saveField = async () => {
    if (props.mode !== 'edit' || readOnly) return;
    const current = form.getValues();
    const patch = Object.fromEntries(Object.entries(current).filter(([k, v]) => v !== saved.current[k]));
    if (Object.keys(patch).length === 0) return;
    if (!(await form.trigger())) {
      setSave({ kind: 'error', message: 'fix the highlighted fields to save.' });
      return;
    }
    setSave({ kind: 'saving' });
    try {
      await props.onSave(patch);
      saved.current = { ...saved.current, ...patch };
      setSave({ kind: 'saved', at: new Date() });
    } catch (e) {
      const msg = applyServerError(e, form.setError);
      setSave({ kind: 'error', message: msg ?? 'Fix the highlighted field.' });
    }
  };

  const onSubmit = form.handleSubmit(async (v) => {
    if (props.mode !== 'create') return;
    setFormError(null);
    try {
      await props.onSubmit(v); // already parsed by the resolver
    } catch (e) {
      setFormError(applyServerError(e, form.setError));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-[var(--form-max-width)] flex-col gap-6">
      {props.mode === 'edit' && !readOnly && <SaveIndicator state={save} onRetry={() => setSave({ kind: 'idle' })} />}
      {formError && <ErrorState message={formError} />}
      {sections.map((section) => (
        <fieldset key={section.title} className="rounded-panel border border-rule bg-surface p-6">
          <legend className="px-1 text-h3 font-semibold text-ink">{section.title}</legend>
          {section.description && <p className="-mt-1 mb-4 text-small text-ink-muted">{section.description}</p>}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-[767px]:grid-cols-1">
            {section.fields.map((f) => {
              const error = form.formState.errors[f.name]?.message as string | undefined;
              const id = `field-${f.name}`;
              const reg = form.register(f.name as Path<Values>, { onBlur: () => void saveField() });
              const common = {
                id,
                readOnly,
                'aria-invalid': error ? true : undefined,
                'aria-describedby': error ? `${id}-error` : f.hint ? `${id}-hint` : undefined,
                className: cn(
                  'h-9 w-full rounded-input border border-rule-strong bg-surface px-3 text-body text-ink',
                  readOnly && 'border-transparent bg-surface-sunken',
                  error && 'border-critical',
                  f.kind === 'coordinate' && 'text-right',
                ),
              };
              return (
                <div key={f.name} className={cn('flex flex-col gap-1', f.wide && 'col-span-2 max-[767px]:col-span-1')}>
                  <label htmlFor={id} className="text-body font-semibold text-ink">
                    {f.label}
                    {!f.required && !readOnly && <span className="ml-1 font-normal text-ink-muted">(optional)</span>}
                  </label>
                  {f.kind === 'country' ? (
                    <select {...reg} {...common} disabled={readOnly}>
                      <option value="">Choose a country…</option>
                      {countries.data?.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      {...reg}
                      {...common}
                      type={f.kind === 'email' ? 'email' : f.kind === 'tel' ? 'tel' : 'text'}
                      inputMode={f.kind === 'coordinate' ? 'decimal' : undefined}
                    />
                  )}
                  {f.hint && !error && (
                    <p id={`${id}-hint`} className="text-small text-ink-muted">
                      {f.hint}
                    </p>
                  )}
                  {error && (
                    <p id={`${id}-error`} className="text-small text-ink">
                      <span aria-hidden className="mr-1 inline-block size-2 rounded-full bg-critical" />
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      {props.mode === 'create' && (
        <div className="flex justify-end gap-2">
          {props.onCancel && <Button onClick={props.onCancel}>Cancel</Button>}
          <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
            {props.submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const text =
    state.kind === 'saving'
      ? 'Saving…'
      : state.kind === 'saved'
        ? `Saved ${state.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
        : state.kind === 'error'
          ? `Couldn't save — ${state.message}`
          : 'Changes save when you leave a field.';
  return (
    <p role="status" className="flex items-center gap-2 text-small text-ink-muted">
      {state.kind === 'error' && <span aria-hidden className="inline-block size-2 rounded-full bg-critical" />}
      {text}
      {state.kind === 'error' && (
        <Button variant="quiet" className="h-6" onClick={onRetry}>
          Dismiss
        </Button>
      )}
    </p>
  );
}

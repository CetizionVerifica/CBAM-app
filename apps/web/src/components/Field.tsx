import { type InputHTMLAttributes, type ReactNode, forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: ReactNode;
}

/** Labelled text input with inline validation (design system 5.2, 7). */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, className, id, ...props },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const describedBy = [error && `${inputId}-error`, hint && `${inputId}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-body font-semibold text-ink">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'h-9 rounded-input border border-rule-strong bg-surface px-3 text-body text-ink placeholder:text-ink-muted',
          'read-only:border-rule read-only:bg-surface-sunken',
          error && 'border-critical',
          className,
        )}
        {...props}
      />
      {hint && !error && (
        <p id={`${inputId}-hint`} className="text-small text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${inputId}-error`} className="text-small text-ink">
          <span aria-hidden className="mr-1 inline-block size-2 rounded-full bg-critical" />
          {error}
        </p>
      )}
    </div>
  );
});

export function SelectField({
  label,
  error,
  options,
  ...props
}: InputHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; options: { value: string; label: string }[] }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-body font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        className={cn('h-9 rounded-input border border-rule-strong bg-surface px-2 text-body text-ink', error && 'border-critical')}
        {...(props as object)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="text-small text-ink">{error}</p>}
    </div>
  );
}

import { type Provenance, type StoredAmount, UNITS, type UnitId } from '@cbam/shared';
import { BookOpen, Calculator, Gauge, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { formatExact, unitLabel } from '@/lib/format';

/** A quantity as typed: every field a string, nothing converted until the API normalises it (G5). */
export interface QuantityDraft {
  value: string;
  unit: string;
  provenance: Provenance;
  source: string;
  /** Library entry a default value came from; kept so a stored default saves unchanged (review M5 F11). */
  defaultRef?: string;
}

export const emptyDraft = (unit: string): QuantityDraft => ({ value: '', unit, provenance: 'measured', source: '' });

export const draftFrom = (a: StoredAmount | null, unit: string): QuantityDraft =>
  a ? { value: a.value, unit: a.unit, provenance: a.provenance, source: a.source, ...(a.defaultRef && { defaultRef: a.defaultRef }) } : emptyDraft(unit);

/** Empty value means "not entered" (null); anything else goes to the API as typed. */
export const draftToInput = (d: QuantityDraft) =>
  d.value.trim() === ''
    ? null
    : {
        value: d.value.trim(),
        unit: d.unit,
        provenance: d.provenance,
        source: d.source.trim(),
        // Only a default value carries its library reference.
        ...(d.provenance === 'default' && d.defaultRef && { defaultRef: d.defaultRef }),
      };

const PROVENANCE: Record<Provenance, { label: string; icon: LucideIcon }> = {
  measured: { label: 'Measured', icon: Gauge },
  estimated: { label: 'Estimated', icon: Calculator },
  default: { label: 'Default value', icon: BookOpen },
};

/** Provenance chip (design system 5.4): icon plus word in forms. */
export function ProvenanceChip({ provenance }: { provenance: Provenance }) {
  const { label, icon: Icon } = PROVENANCE[provenance];
  return (
    <span className="inline-flex items-center gap-1 text-caption text-ink-muted">
      <Icon aria-hidden className="size-3.5" strokeWidth={1.5} />
      {label}
    </span>
  );
}

/** "1,000 t" with the unit muted (design system 3.4); exact digits, as entered. */
export function Amount({ amount }: { amount: Pick<StoredAmount, 'value' | 'unit'> | null }) {
  if (!amount) return <span className="text-ink-muted">—</span>;
  return (
    <span className="tabular-nums whitespace-nowrap text-ink">
      {formatExact(amount.value)} <span className="text-ink-muted">{unitLabel(amount.unit)}</span>
    </span>
  );
}

/**
 * Numeric input with unit and provenance (design system 5.2): value right-aligned, unit
 * selector, provenance and data source next to it. Locked or read-only renders plain text.
 * Default values need a library reference, so only measured and estimated are offered here.
 */
export function QuantityInput({
  label,
  draft,
  units,
  onChange,
  errors = {},
  readOnly = false,
  required = false,
}: {
  label: string;
  draft: QuantityDraft;
  units: readonly UnitId[];
  onChange: (d: QuantityDraft) => void;
  /** Messages keyed by field: value, unit, source, provenance. */
  errors?: Partial<Record<keyof QuantityDraft, string>>;
  readOnly?: boolean;
  required?: boolean;
}) {
  const id = useId();
  if (readOnly) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-body font-semibold text-ink">{label}</span>
        <div className="flex flex-wrap items-center gap-3 rounded-input bg-surface-sunken px-3 py-1.5">
          <Amount amount={draft.value ? draft : null} />
          {draft.value && <ProvenanceChip provenance={draft.provenance} />}
          {draft.value && draft.source && <span className="text-small text-ink-muted">{draft.source}</span>}
        </div>
      </div>
    );
  }
  const message = errors.value ?? errors.unit ?? errors.provenance ?? errors.source;
  const set = (patch: Partial<QuantityDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-value`} className="text-body font-semibold text-ink">
        {label}
        {required && <span className="font-normal text-ink-muted"> (required)</span>}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn('flex h-9 rounded-input border border-rule-strong bg-surface', message && 'border-critical')}>
          <input
            id={`${id}-value`}
            inputMode="decimal"
            aria-invalid={errors.value ? true : undefined}
            aria-describedby={message ? `${id}-error` : undefined}
            className="w-32 rounded-l-input bg-transparent px-3 text-right text-body tabular-nums text-ink"
            value={draft.value}
            onChange={(e) => set({ value: e.target.value })}
          />
          <select
            aria-label={`${label}: unit`}
            className="rounded-r-input border-l border-rule bg-surface-sunken px-2 text-caption text-ink"
            value={draft.unit}
            onChange={(e) => set({ unit: e.target.value })}
          >
            {units.map((u) => (
              <option key={u} value={u}>
                {UNITS[u].label || 'fraction'}
              </option>
            ))}
          </select>
        </div>
        <select
          aria-label={`${label}: provenance`}
          className="h-9 rounded-input border border-rule-strong bg-surface px-2 text-small text-ink"
          value={draft.provenance}
          onChange={(e) => set({ provenance: e.target.value as Provenance })}
        >
          <option value="measured">Measured</option>
          <option value="estimated">Estimated</option>
          {draft.provenance === 'default' && <option value="default">Default value</option>}
        </select>
        <input
          aria-label={`${label}: data source`}
          placeholder="Data source, e.g. weighbridge log"
          className={cn('h-9 min-w-48 flex-1 rounded-input border border-rule-strong bg-surface px-3 text-small text-ink placeholder:text-ink-muted', errors.source && 'border-critical')}
          value={draft.source}
          onChange={(e) => set({ source: e.target.value })}
        />
      </div>
      {message && (
        <p id={`${id}-error`} className="text-small text-ink">
          <span aria-hidden className="mr-1 inline-block size-2 rounded-full bg-critical" />
          {message}
        </p>
      )}
    </div>
  );
}

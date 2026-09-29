import { PERIOD_TRANSITIONS, type PeriodAction, PeriodInput, isCalendarYear, periodEndDate } from '@cbam/shared';
import { useId, useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { Field } from '@/components/Field';
import { ErrorState } from '@/components/States';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

type Errors = Partial<Record<'startDate' | 'endDate' | 'justification', string>>;

/**
 * Open, clone or re-date a period (M3-R1, R2, R6). The user picks the start; the end is
 * always 12 months later and shown, not typed. A justification appears when the start is
 * not 1 January. Validation is the shared PeriodInput schema, so messages match the API.
 */
export function PeriodFormDialog({
  title,
  description,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  submitLabel: string;
  initial: { startDate: string; justification?: string | null };
  onSubmit: (input: PeriodInput) => Promise<void>;
  onClose: () => void;
}) {
  const [startDate, setStartDate] = useState(initial.startDate);
  const [justification, setJustification] = useState(initial.justification ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const validStart = /^\d{4}-\d{2}-\d{2}$/.test(startDate);
  const endDate = validStart ? periodEndDate(startDate) : '';
  const needsJustification = validStart && !isCalendarYear(startDate);

  const submit = async () => {
    const parsed = PeriodInput.safeParse({ startDate, endDate, justification: needsJustification ? justification : '' });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message])));
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await onSubmit(parsed.data);
    } catch (e) {
      if (e instanceof ApiError && e.issues.length > 0) {
        setErrors(Object.fromEntries(e.issues.map((i) => [i.path[0], i.message])));
      }
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={description}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Start date"
          type="date"
          value={startDate}
          required
          error={errors.startDate}
          onChange={(e) => setStartDate(e.target.value)}
          hint="Reporting periods cover 12 months. The calendar year is the default."
        />
        <div className="flex flex-col gap-1">
          <span className="text-body font-semibold text-ink">End date</span>
          <span className="flex h-9 items-center rounded-input bg-surface-sunken px-3 text-body tabular-nums text-ink">
            {endDate ? formatDate(endDate) : '—'}
          </span>
          {errors.endDate && <p className="text-small text-ink">{errors.endDate}</p>}
        </div>
        {needsJustification && (
          <TextArea
            label="Why not the calendar year?"
            value={justification}
            error={errors.justification}
            onChange={setJustification}
            placeholder="For example: the operator’s financial year runs April to March."
          />
        )}
        {formError && <ErrorState message={formError} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !validStart}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TextArea({ label, value, error, placeholder, onChange }: { label: string; value: string; error?: string; placeholder?: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-body font-semibold text-ink">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={3}
        maxLength={2000}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn('rounded-input border border-rule-strong bg-surface px-3 py-2 text-body text-ink placeholder:text-ink-muted', error && 'border-critical')}
      />
      {error && (
        <p id={`${id}-error`} className="text-small text-ink">
          <span aria-hidden className="mr-1 inline-block size-2 rounded-full bg-critical" />
          {error}
        </p>
      )}
    </div>
  );
}

// Design system 7: confirm only irreversible or wide-impact steps, stating the consequence.
const CONSEQUENCE: Partial<Record<PeriodAction, string>> = {
  approve: 'Approving locks all data in this period. Changes will need it returned to draft or, after issue, a new version.',
  issue: 'Issuing locks this version for good. Later changes will go into a new version; this one stays as issued.',
  reopen: 'The period goes back to draft and its data can be edited again. The reason is kept in the history and the audit trail.',
};

export const needsConfirmation = (action: PeriodAction) => action in CONSEQUENCE;

/** Confirm approve or issue; ask for the reason when returning to draft (M3-R3). */
export function TransitionDialog({
  action,
  periodLabel,
  onConfirm,
  onClose,
}: {
  action: PeriodAction;
  periodLabel: string;
  onConfirm: (reason?: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = PERIOD_TRANSITIONS[action];
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (t.needsReason && !reason.trim()) {
      setReasonError('Say why this period goes back to draft.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(t.needsReason ? reason.trim() : undefined);
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${t.label}: ${periodLabel}?`} description={CONSEQUENCE[action]}>
      <div className="flex flex-col gap-4">
        {t.needsReason && <TextArea label="Reason" value={reason} error={reasonError} onChange={setReason} />}
        {error && <ErrorState message={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={confirm}>
            {t.label}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

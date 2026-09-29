import { AlertTriangle, Lock } from 'lucide-react';
import type { ReactNode } from 'react';

// Design system 5.7: empty, error, blocked and locked states. No apologies, no vague copy.

export function EmptyState({ message, actions }: { message: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-panel border border-rule bg-surface p-8">
      <p className="max-w-[72ch] text-body text-ink">{message}</p>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorState({ message, actions }: { message: string; actions?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-panel border border-rule bg-critical-tint p-4">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" strokeWidth={1.5} />
      <div className="flex flex-col gap-3">
        <p className="text-body text-ink">{message}</p>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function LockedBanner({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div role="status" className="flex items-center gap-3 border-t-2 border-locked bg-locked-tint px-6 py-2">
      <Lock aria-hidden className="size-4 shrink-0 text-locked" strokeWidth={1.5} />
      <p className="flex-1 text-small text-ink">{message}</p>
      {action}
    </div>
  );
}

/** Skeleton rows matching the final layout (design system 5.7). */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-input bg-surface-sunken" />
      ))}
    </div>
  );
}

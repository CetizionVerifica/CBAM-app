import type { PeriodStatus } from '@cbam/shared';
import { CircleDashed, Eye, Lock, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

// Design system 5.4: tinted background, caption size, icon plus word; text stays --ink.
const STATUS: Record<PeriodStatus, { label: string; icon: LucideIcon; tint: string; iconColor: string }> = {
  draft: { label: 'Draft', icon: CircleDashed, tint: 'bg-surface-sunken', iconColor: 'text-ink-muted' },
  in_review: { label: 'In review', icon: Eye, tint: 'bg-info-tint', iconColor: 'text-info' },
  approved: { label: 'Approved', icon: Lock, tint: 'bg-locked-tint', iconColor: 'text-locked' },
  issued: { label: 'Issued', icon: Lock, tint: 'bg-locked-tint', iconColor: 'text-locked' },
};

export function StatusBadge({ status, className }: { status: PeriodStatus; className?: string }) {
  const { label, icon: Icon, tint, iconColor } = STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-input px-2 py-0.5 text-caption font-medium text-ink',
        tint,
        className,
      )}
    >
      <Icon aria-hidden className={cn('size-3.5', iconColor)} strokeWidth={1.5} />
      {label}
    </span>
  );
}

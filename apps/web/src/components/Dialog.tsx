import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Modal dialog on Radix (design system 5, 7 "Confirmation"). */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 bg-ink/30" />
        <RD.Content className="fixed top-1/2 left-1/2 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-panel border border-rule bg-surface p-6 shadow-float">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <RD.Title className="text-h2 font-semibold text-ink">{title}</RD.Title>
              {description && <RD.Description className="mt-1 text-body text-ink-muted">{description}</RD.Description>}
            </div>
            <RD.Close aria-label="Close" className="rounded-button p-1 text-ink-muted hover:bg-surface-sunken">
              <X aria-hidden className="size-4" strokeWidth={1.5} />
            </RD.Close>
          </div>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

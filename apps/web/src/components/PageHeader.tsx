import type { ReactNode } from 'react';

// Design system 4: screen title, one line on what the screen is for, actions on the right.
export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-6">
      <div>
        <h1 className="text-h1 font-semibold text-ink">{title}</h1>
        <p className="mt-1 text-body text-ink-muted">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}

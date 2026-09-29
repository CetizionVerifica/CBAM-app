import type { ReactNode } from 'react';

/** Centred panel for sign-in, 2FA and invitation screens (max 880 px forms rule; 400 px here). */
export function AuthLayout({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-canvas px-4 pt-[12vh]">
      <main className="w-full max-w-[400px]">
        <p className="mb-6 text-h3 font-semibold text-ink">CBAM reporting</p>
        <div className="rounded-panel border border-rule bg-surface p-6">
          <h1 className="text-h1 font-semibold text-ink">{title}</h1>
          {description && <p className="mt-1 text-body text-ink-muted">{description}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

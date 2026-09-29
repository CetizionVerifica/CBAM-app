import { CreateLibraryVersionRequest, type LibraryVersionSummary, can } from '@cbam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { CircleDashed, Lock } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router';
import type { z } from 'zod';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Dialog } from '@/components/Dialog';
import { Field, SelectField } from '@/components/Field';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LockedBanner, SkeletonRows } from '@/components/States';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { applyServerError } from '@/lib/forms';
import { useMe } from '@/lib/session';
import { CnCodesTab, GoodsTab, TemplatesTab } from './ConfigTabs';
import { FactorTab } from './FactorTab';
import { ImportDialog } from './ImportDialog';
import { PublishDialog } from './PublishDialog';
import { FACTOR_TABS, libraryKeys, useLibraryVersions } from './queries';

const TABS = [
  ...FACTOR_TABS.map((t) => ({ id: t.kind as string, label: t.label })),
  { id: 'cn_codes', label: 'CN codes' },
  { id: 'goods', label: 'Goods and routes' },
  { id: 'templates', label: 'Templates' },
];

export function VersionBadge({ version }: { version: Pick<LibraryVersionSummary, 'status' | 'isCurrent'> }) {
  const draft = version.status === 'draft';
  const Icon = draft ? CircleDashed : Lock;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-input px-2 py-0.5 text-caption font-medium text-ink', draft ? 'bg-surface-sunken' : 'bg-locked-tint')}>
      <Icon aria-hidden className={cn('size-3.5', draft ? 'text-ink-muted' : 'text-locked')} strokeWidth={1.5} />
      {draft ? 'Draft' : version.isCurrent ? 'Published · current' : 'Published'}
    </span>
  );
}

/** M4 reference library (design system 6.12). Everyone reads; the platform admin edits drafts and publishes. */
export function LibraryPage() {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const versions = useLibraryVersions();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<'new' | 'import' | 'publish' | 'discard' | null>(null);
  const canWrite = can(me.user.role, 'library.write');

  if (versions.isPending) return <div className="p-6"><SkeletonRows rows={10} /></div>;
  if (versions.isError) return <div className="p-6"><ErrorState message={versions.error.message} /></div>;

  const list = versions.data;
  const draft = list.find((v) => v.status === 'draft');
  const selected = list.find((v) => v.id === params.get('version')) ?? list.find((v) => v.isCurrent) ?? list[0];
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : TABS[0]!.id;
  const set = (key: string, value: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set(key, value);
      return next;
    });
  const refresh = () => qc.invalidateQueries({ queryKey: ['library'] });

  if (!selected) {
    return (
      <div className="p-6">
        <PageHeader title="Reference library" description="Factors, default values and CN codes the calculations use." />
        <EmptyState
          message="The library has no versions yet. Create a draft version and import the official files."
          actions={canWrite && <Button variant="primary" onClick={() => setDialog('new')}>Create draft version</Button>}
        />
        {dialog === 'new' && <NewVersionDialog onClose={() => setDialog(null)} onCreated={(v) => { void refresh(); set('version', v.id); setDialog(null); toast('Draft version created'); }} />}
      </div>
    );
  }

  const editable = canWrite && selected.status === 'draft';

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const next = TABS[(i + d + TABS.length) % TABS.length]!;
    set('tab', next.id);
    document.getElementById(`library-tab-${next.id}`)?.focus();
  };

  return (
    <>
      <div className="p-6">
        <PageHeader
          title="Reference library"
          description="Factors, default values and CN codes the calculations use. Each reporting period pins one published version."
          actions={
            canWrite && (
              <>
                {!draft && <Button onClick={() => setDialog('new')}>Create draft version</Button>}
                {editable && <Button onClick={() => setDialog('import')}>Import file</Button>}
                {editable && <Button variant="destructive" onClick={() => setDialog('discard')}>Discard draft</Button>}
                {editable && <Button variant="primary" onClick={() => setDialog('publish')}>Publish version</Button>}
              </>
            )
          }
        />

        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="w-72">
            <SelectField
              label="Version"
              value={selected.id}
              onChange={(e) => set('version', (e.target as HTMLSelectElement).value)}
              options={list.map((v) => ({ value: v.id, label: `${v.code} — ${v.status === 'draft' ? 'draft' : v.isCurrent ? 'published, current' : 'published'}` }))}
            />
          </div>
          <div className="flex items-center gap-3 pb-1.5 text-small text-ink-muted">
            <VersionBadge version={selected} />
            {selected.basedOnCode && <span>Based on {selected.basedOnCode}</span>}
            {selected.publishedAt && <span>Published {new Date(selected.publishedAt).toLocaleDateString()}</span>}
          </div>
        </div>
        {selected.notes && <p className="mb-4 max-w-[72ch] text-body text-ink-muted">{selected.notes}</p>}
      </div>

      {selected.status === 'published' && (
        <LockedBanner
          message={`Version ${selected.code} is published and read-only. Changes go into a new draft version.`}
          action={
            canWrite &&
            (draft ? (
              <Button variant="quiet" onClick={() => set('version', draft.id)}>Open draft {draft.code}</Button>
            ) : (
              <Button variant="quiet" onClick={() => setDialog('new')}>Create draft version</Button>
            ))
          }
        />
      )}

      <div className="p-6 pt-4">
        <div role="tablist" aria-label="Library tables" className="mb-4 flex gap-1 overflow-x-auto border-b border-rule">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`library-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              aria-controls="library-panel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => set('tab', t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={cn(
                '-mb-px h-9 border-b-2 px-3 text-body whitespace-nowrap',
                tab === t.id ? 'border-action font-semibold text-ink' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id="library-panel" role="tabpanel" aria-labelledby={`library-tab-${tab}`}>
          {FACTOR_TABS.some((f) => f.kind === tab) ? (
            <FactorTab version={selected} kind={FACTOR_TABS.find((f) => f.kind === tab)!.kind} editable={editable} />
          ) : tab === 'cn_codes' ? (
            <CnCodesTab version={selected} />
          ) : tab === 'goods' ? (
            <GoodsTab version={selected} editable={editable} />
          ) : (
            <TemplatesTab />
          )}
        </div>
      </div>

      {dialog === 'new' && (
        <NewVersionDialog
          onClose={() => setDialog(null)}
          onCreated={(v) => {
            void refresh();
            set('version', v.id);
            setDialog(null);
            toast('Draft version created');
          }}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          versionId={selected.id}
          versionCode={selected.code}
          onClose={() => setDialog(null)}
          onApplied={(rows) => {
            void refresh();
            setDialog(null);
            toast(`Import applied: ${rows} rows`);
          }}
        />
      )}
      {dialog === 'publish' && (
        <PublishDialog
          version={selected}
          onClose={() => setDialog(null)}
          onPublished={() => {
            void refresh();
            setDialog(null);
            toast(`Version ${selected.code} published`);
          }}
        />
      )}
      {dialog === 'discard' && (
        <ConfirmDialog
          title={`Discard draft ${selected.code}?`}
          consequence="All changes and imports in this draft are deleted. Published versions are not affected."
          confirmLabel="Discard draft"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.delete(`/library/versions/${selected.id}`);
            setParams({});
            await refresh();
            setDialog(null);
            toast('Draft discarded');
          }}
        />
      )}
    </>
  );
}

type NewVersionValues = z.input<typeof CreateLibraryVersionRequest>;

function NewVersionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (v: LibraryVersionSummary) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<NewVersionValues>({
    resolver: zodResolver(CreateLibraryVersionRequest),
    mode: 'onBlur',
    defaultValues: { code: '', notes: '' },
  });
  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const res = await api.post<{ version: LibraryVersionSummary }>('/library/versions', values);
      onCreated(res.version);
    } catch (e) {
      setFormError(applyServerError(e, form.setError));
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Create draft version" description="The draft starts as a copy of the current published version. Edit it, import files, then publish.">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {formError && <ErrorState message={formError} />}
        <Field label="Version code" hint="Like 2026.2. It cannot be changed later." autoFocus error={form.formState.errors.code?.message} {...form.register('code')} />
        <Field label="What changes (optional)" error={form.formState.errors.notes?.message} {...form.register('notes')} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>Create draft version</Button>
        </div>
      </form>
    </Dialog>
  );
}

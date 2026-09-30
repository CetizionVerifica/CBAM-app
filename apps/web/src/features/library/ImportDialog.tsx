import { IMPORT_COLUMNS, IMPORT_MAX_CHARS, type ImportDataset, type ImportPreview, type ImportRowError } from '@cbam/shared';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Dialog } from '@/components/Dialog';
import { SelectField } from '@/components/Field';
import { ErrorState } from '@/components/States';
import { ApiError, api } from '@/lib/api';
import { DatasetDiffTable, DiffSummary } from './DiffView';

const DATASETS: { value: ImportDataset; label: string; replaces: string }[] = [
  { value: 'factors', label: 'Factors (emission factors, NCVs, grid factors, GWPs, default values)', replaces: 'Replaces every factor of the kinds that appear in the file. Other kinds stay as they are.' },
  { value: 'cn_codes', label: 'CN codes', replaces: 'Replaces the whole CN-code list of this draft.' },
];

/**
 * M4-R4: upload → whole-file validation (rejected with line numbers, AT2) → diff preview →
 * apply to the draft. Nothing changes until "Apply to draft".
 */
export function ImportDialog({ versionId, versionCode, onClose, onApplied }: { versionId: string; versionCode: string; onClose: () => void; onApplied: (rows: number) => void }) {
  const [dataset, setDataset] = useState<ImportDataset>('factors');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<ImportRowError[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const cols = IMPORT_COLUMNS[dataset];

  const check = async () => {
    if (!file) return setError('Choose a .csv file.');
    setBusy(true);
    setError(null);
    setRowErrors([]);
    try {
      const content = await file.text();
      if (content.length > IMPORT_MAX_CHARS) throw new ApiError(400, 'too_large', 'The file is larger than 8 MB. Split it into smaller files.');
      const res = await api.post<{ preview: ImportPreview }>(`/library/versions/${versionId}/imports`, { dataset, fileName: file.name, content });
      setPreview(res.preview);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.issues[0]?.message ?? e.message);
        setRowErrors((e.details as { errors?: ImportRowError[] } | undefined)?.errors ?? []);
      } else setError('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ rowCount: number }>(`/library/imports/${preview!.id}/apply`);
      onApplied(res.rowCount);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Import into draft ${versionCode}`} description="The whole file is checked first. Nothing changes until you apply it.">
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        {!preview ? (
          <>
            <SelectField
              label="What the file contains"
              value={dataset}
              onChange={(e) => setDataset((e.target as HTMLSelectElement).value as ImportDataset)}
              options={DATASETS.map((d) => ({ value: d.value, label: d.label }))}
            />
            <p className="text-small text-ink-muted">{DATASETS.find((d) => d.value === dataset)!.replaces}</p>
            <div className="flex flex-col gap-1">
              <label htmlFor="import-file" className="text-body font-semibold text-ink">CSV file</label>
              <input id="import-file" type="file" accept=".csv,text/csv" className="text-body text-ink" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <p className="text-small text-ink-muted">
                Columns: <span className="font-mono">{cols.required.join(', ')}</span>
                {cols.optional.length > 0 && <>; optional <span className="font-mono">{cols.optional.join(', ')}</span></>}.
              </p>
            </div>
            {error && <ErrorState message={error} />}
            {rowErrors.length > 0 && (
              <div className="max-h-56 overflow-y-auto rounded-panel border border-rule">
                <table className="w-full text-left text-small">
                  <thead className="sticky top-0 bg-surface-sunken text-ink">
                    <tr>
                      <th scope="col" className="h-8 border-b border-rule px-3 text-right font-semibold">Line</th>
                      <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">Column</th>
                      <th scope="col" className="h-8 border-b border-rule px-3 font-semibold">Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowErrors.map((r, i) => (
                      <tr key={i} className="border-b border-rule last:border-b-0">
                        <td className="px-3 py-1 text-right tabular-nums text-ink">{r.row}</td>
                        <td className="px-3 py-1 font-mono text-ink">{r.column ?? '—'}</td>
                        <td className="px-3 py-1 text-ink">{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={busy || !file} onClick={check}>Check file</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-body text-ink">
              <span className="font-semibold">{preview.fileName}</span>: <span className="tabular-nums">{preview.rowCount}</span> rows, all valid.
            </p>
            <DiffSummary diff={preview.diff} />
            <DatasetDiffTable diff={preview.diff} />
            {error && <ErrorState message={error} />}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setPreview(null)}>Choose another file</Button>
              <Button variant="primary" disabled={busy} onClick={apply}>Apply to draft</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

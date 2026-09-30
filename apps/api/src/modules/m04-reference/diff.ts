import type { DatasetDiff } from '@cbam/shared';

/** One comparable library row: its natural key, a readable label, and the compared fields. */
export interface DiffRecord {
  key: string;
  label: string;
  fields: Record<string, string | number | boolean | null>;
}

/**
 * Added, changed and removed rows between two sets of records keyed the same way
 * (M4-R4 import preview, publish preview). Field values must already be normalised
 * (decimals via Decimal#toString), so "56.10" and "56.1" compare equal.
 */
export function diffRecords(before: DiffRecord[], after: DiffRecord[]): DatasetDiff {
  const old = new Map(before.map((r) => [r.key, r]));
  const next = new Map(after.map((r) => [r.key, r]));
  const diff: DatasetDiff = { added: [], changed: [], removed: [] };

  for (const [key, a] of next) {
    const b = old.get(key);
    if (!b) {
      diff.added.push({ key, label: a.label, after: a.fields });
      continue;
    }
    const fields = [...new Set([...Object.keys(b.fields), ...Object.keys(a.fields)])].filter(
      (f) => (b.fields[f] ?? null) !== (a.fields[f] ?? null),
    );
    if (fields.length) diff.changed.push({ key, label: a.label, before: b.fields, after: a.fields, fields: fields.sort() });
  }
  for (const [key, b] of old) {
    if (!next.has(key)) diff.removed.push({ key, label: b.label, before: b.fields });
  }
  const byKey = (x: { key: string }, y: { key: string }) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  diff.added.sort(byKey);
  diff.changed.sort(byKey);
  diff.removed.sort(byKey);
  return diff;
}

export const isEmptyDiff = (d: DatasetDiff) => d.added.length + d.changed.length + d.removed.length === 0;

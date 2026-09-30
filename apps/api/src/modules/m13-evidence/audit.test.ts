import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@cbam/shared';
import { changesOf, exportAuditCsv } from './audit.router';

const entry = (id: number): AuditEntry => ({
  id, occurredAt: '2026-09-30T08:00:00.000Z', actorId: 'u1', actorName: 'Cara', actorRole: 'consultant', action: 'Edit installation',
  op: 'UPDATE', table: 'public.installation', recordId: 'i1', clientId: 'c1', reason: null, changes: [{ field: 'city', old: 'A', new: String(id) }],
});

describe('audit CSV export (review M13 F7)', () => {
  it('reads page after page with the cursor until a short page, so nothing is cut off', async () => {
    const all = [9, 8, 7, 6, 5].map(entry);
    const cursors: (number | undefined)[] = [];
    const chunks: string[] = [];
    const total = await exportAuditCsv(
      async (before) => {
        cursors.push(before);
        return all.filter((e) => before === undefined || e.id < before).slice(0, 2);
      },
      (c) => chunks.push(c),
      2,
    );
    expect(total).toBe(5);
    expect(cursors).toEqual([undefined, 8, 6]); // pages [9,8] [7,6] [5]; the short page ends it
    const lines = chunks.join('').replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(6); // header + 5
    expect(lines.at(-1)).toContain('"city","A","5"');
  });
});

describe('changesOf (M13-R6)', () => {
  it('lists changed fields for updates and every field for inserts, without row metadata', () => {
    expect(changesOf('UPDATE', { city: 'A', updated_at: 'x' }, { city: 'B', updated_at: 'y' }, ['city'])).toEqual([{ field: 'city', old: 'A', new: 'B' }]);
    expect(changesOf('INSERT', null, { city: 'B', created_by: 'u' }, null)).toEqual([{ field: 'city', old: null, new: 'B' }]);
    expect(changesOf('DELETE', { city: 'A' }, null, null)).toEqual([{ field: 'city', old: 'A', new: null }]);
  });
});

import { Router } from 'express';
import { sql } from 'kysely';
import { AUDIT_MODULES, type AuditChange, type AuditEntry, AuditQuery } from '@cbam/shared';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { type Db, type Tx, withContext } from '../../platform/db';

// Row metadata is in every entry and says nothing a user needs; it is left out of changes.
const META = new Set(['created_at', 'created_by', 'updated_at', 'updated_by']);

type Json = Record<string, unknown> | null;

/**
 * Parses a logged row keeping numbers as their exact source text (G6): a numeric(…) value
 * like 28.123456789012345678 must not pass through a JS float on its way to the screen.
 * Uses JSON.parse source text access (Node ≥ 21).
 */
const parseRow = (text: string | null): Json =>
  text === null
    ? null
    : (JSON.parse(text, (_k, v, ctx?: { source?: string }) => (typeof v === 'number' && ctx?.source ? ctx.source : v)) as Json);

/** M13-R6: the fields a change touched, each with its old and new value. */
export function changesOf(op: string, oldRow: Json, newRow: Json, changedFields: string[] | null): AuditChange[] {
  const fields =
    op === 'UPDATE' ? (changedFields ?? []) : Object.keys((op === 'INSERT' ? newRow : oldRow) ?? {});
  return fields
    .filter((f) => !META.has(f))
    .map((field) => ({ field, old: oldRow?.[field] ?? null, new: newRow?.[field] ?? null }));
}

const CSV_PAGE = 1000;

/**
 * Writes the CSV for every entry `fetchPage` returns, page after page (newest first), until a
 * page is short: nothing is cut off (review M13 F7). Exported for tests.
 */
export async function exportAuditCsv(
  fetchPage: (before: number | undefined) => Promise<AuditEntry[]>,
  write: (chunk: string) => void,
  pageSize = CSV_PAGE,
): Promise<number> {
  const header = ['Time (UTC)', 'User', 'Role', 'Action', 'Operation', 'Table', 'Record', 'Field', 'Old value', 'New value', 'Reason'];
  write(`﻿${header.map(csvCell).join(',')}\r\n`);
  let before: number | undefined;
  let total = 0;
  for (;;) {
    const page = await fetchPage(before);
    const lines: string[] = [];
    for (const e of page) {
      const base = [e.occurredAt, e.actorName ?? e.actorId, e.actorRole, e.action, e.op, e.table, e.recordId];
      const changes = e.changes.length ? e.changes : [{ field: '', old: null, new: null }];
      for (const c of changes) lines.push([...base, c.field, c.old, c.new, e.reason].map(csvCell).join(','));
    }
    if (lines.length) write(`${lines.join('\r\n')}\r\n`);
    total += page.length;
    if (page.length < pageSize) return total;
    before = page.at(-1)!.id;
  }
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Quote everything; neutralise spreadsheet formulas (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replaceAll('"', '""')}"`;
};

/**
 * M13-R5 — the audit trail: reverse-chronological, filterable by client, user, module,
 * record and time; one row per entry with old and new values (R6). Read access is RLS:
 * admins see the tenant, consultants and reviewers their clients. The log itself is
 * append-only (platform foundation migration).
 */
export function auditRouter({ db }: { db: Db }): Router {
  const router = Router();
  router.use(['/audit', '/audit.csv'], requireAuth, requirePermission('audit.read'));

  const query = async (tx: Tx, q: AuditQuery) => {
    let s = tx
      .selectFrom('audit.audit_log as a')
      .leftJoin('app_user as u', 'u.id', 'a.actor_user_id')
      .select([
        'a.id', 'a.occurred_at', 'a.actor_user_id', 'a.actor_role', 'a.action', 'a.op', 'a.table_name', 'a.record_id',
        'a.client_id', 'a.reason', 'a.changed_fields', 'u.display_name',
        sql<string | null>`a.old_row::text`.as('old_text'),
        sql<string | null>`a.new_row::text`.as('new_text'),
      ])
      .orderBy('a.id', 'desc')
      .limit(q.limit);
    if (q.clientId) s = s.where('a.client_id', '=', q.clientId);
    if (q.userId) s = s.where('a.actor_user_id', '=', q.userId);
    if (q.module) s = s.where('a.table_name', 'in', [...AUDIT_MODULES[q.module]]);
    if (q.table) s = s.where('a.table_name', '=', q.table);
    if (q.recordId) s = s.where('a.record_id', '=', q.recordId);
    if (q.from) s = s.where('a.occurred_at', '>=', new Date(q.from));
    if (q.to) s = s.where('a.occurred_at', '<', new Date(q.to));
    if (q.before) s = s.where('a.id', '<', String(q.before));
    const rows = await s.execute();
    return rows.map(
      (r): AuditEntry => ({
        id: Number(r.id),
        occurredAt: r.occurred_at.toISOString(),
        actorId: r.actor_user_id,
        actorName: r.display_name,
        actorRole: r.actor_role,
        action: r.action,
        op: r.op as AuditEntry['op'],
        table: r.table_name,
        recordId: r.record_id,
        clientId: r.client_id,
        reason: r.reason,
        changes: changesOf(r.op, parseRow(r.old_text), parseRow(r.new_text), r.changed_fields),
      }),
    );
  };

  router.get('/audit', async (req, res) => {
    const q = AuditQuery.parse(req.query);
    const entries = await withContext(db, contextOf(req), (tx) => query(tx, q));
    res.json({ entries, next: entries.length === q.limit ? entries.at(-1)!.id : null });
  });

  // Export (design system 6.11): all matching entries, streamed page by page in one transaction.
  router.get('/audit.csv', async (req, res) => {
    const q = AuditQuery.parse({ ...req.query, limit: undefined });
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="audit-trail.csv"')
      .set('Cache-Control', 'no-store');
    await withContext(db, contextOf(req), (tx) =>
      exportAuditCsv((before) => query(tx, { ...q, before: before ?? q.before, limit: CSV_PAGE }), (chunk) => res.write(chunk)),
    );
    res.end();
  });

  return router;
}

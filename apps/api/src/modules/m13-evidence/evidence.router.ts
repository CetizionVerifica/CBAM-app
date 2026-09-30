import express, { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  EVIDENCE_MAX_BYTES,
  type EvidenceContentType,
  type EvidenceDocType,
  EvidencePatch,
  EvidenceRecordRef,
  type EvidenceRecordType,
  type EvidenceSummary,
  EvidenceUploadQuery,
  can,
} from '@cbam/shared';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { type Db, type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { DOWNLOAD_LINK_SECONDS, type FileStore, sha256Of } from '../../platform/storage';
import { checkEvidenceFile } from './filecheck';
import { labelKey, recordLabels } from './records';

const Id = z.uuid();
const idParam = (raw: unknown, what: string): string => {
  const r = Id.safeParse(raw);
  if (!r.success) throw notFound(what);
  return r.data;
};
const notFound = (what: string) => new AppError(404, 'not_found', `This ${what} does not exist or you do not have access to it.`);

/** Database refusals specific to evidence, in plain words. */
function mapEvidenceDbError(e: unknown): never {
  const err = e as { code?: string; constraint?: string; message?: string };
  if (err.code === '23505' && err.constraint === 'evidence_link_evidence_id_record_table_record_id_key') {
    throw new AppError(409, 'duplicate', 'This evidence is already linked to that record.');
  }
  if (err.code === '23503' && err.message?.includes('has been deleted')) {
    throw new AppError(409, 'deleted', 'This evidence has been deleted, so it cannot support another record.');
  }
  if (err.code === '23503' && err.message?.includes('evidence to link')) throw notFound('evidence');
  if (err.code === '23503' && err.message?.includes('does not exist')) throw notFound('record');
  if (err.code === '23514' && err.message?.includes('different clients')) {
    throw new AppError(409, 'wrong_client', 'That record belongs to another client, so this evidence cannot support it.');
  }
  if (err.code === '23514' && err.message?.includes('another installation')) {
    throw new AppError(409, 'wrong_installation', 'This evidence belongs to another installation, so it cannot support that record.');
  }
  if (err.code === '55000' && err.message?.includes('approved or issued')) {
    throw new AppError(409, 'locked', 'This evidence supports an approved or issued period, so it cannot be changed or deleted.');
  }
  if (err.code === '55000' && err.message?.includes('read-only')) {
    throw new AppError(409, 'locked', 'That period is approved or issued, so its evidence cannot change. Create a new version to make changes.');
  }
  throw e;
}

/**
 * M13 — evidence library: upload (raw body, M13-R3), link to any record (R1), download
 * through a short-lived signed link (R2), and delete while no approved or issued period
 * relies on the file (R4). RLS decides what exists for the caller (G1, D4).
 */
export function evidenceRouter({ db, files }: { db: Db; files: FileStore }): Router {
  const router = Router();
  router.use(['/clients/:id/evidence', '/evidence', '/records'], requireAuth);
  const upload = requirePermission('evidence.upload');
  const rawBody = express.raw({ type: () => true, limit: EVIDENCE_MAX_BYTES });

  const loadEvidence = async (tx: Tx, id: string) => {
    const row = await tx.selectFrom('evidence_document').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw notFound('evidence');
    return row;
  };

  type DocRow = Awaited<ReturnType<typeof loadEvidence>>;

  const assertNotDuplicate = async (tx: Tx, clientId: string, sha256: string) => {
    const same = await tx
      .selectFrom('evidence_document')
      .select(['id', 'title'])
      .where('client_id', '=', clientId)
      .where('sha256', '=', sha256)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (same) {
      throw new AppError(409, 'duplicate', `This file is already in the evidence library as “${same.title}”.`, { existingId: same.id });
    }
  };

  /** Evidence rows with their visible links, labels, lock state and uploader names. */
  const summaries = async (tx: Tx, docs: DocRow[]): Promise<EvidenceSummary[]> => {
    if (docs.length === 0) return [];
    const ids = docs.map((d) => d.id);
    const links = await tx
      .selectFrom('evidence_link as l')
      .leftJoin('period_version as v', 'v.id', 'l.period_version_id')
      .select(['l.id', 'l.evidence_id', 'l.record_table', 'l.record_id', 'l.created_by', 'v.status'])
      .where('l.evidence_id', 'in', ids)
      .orderBy('l.created_at')
      .execute();
    const labels = await recordLabels(
      tx,
      links.map((l) => ({ recordType: l.record_table as EvidenceRecordType, recordId: l.record_id })),
    );
    const locked = await sql<{ id: string; locked: boolean }>`
      select id, app.evidence_is_locked(id) as locked from unnest(${ids}::uuid[]) as id`.execute(tx);
    const lockedIds = new Set(locked.rows.filter((r) => r.locked).map((r) => r.id));
    const uploaders = await tx
      .selectFrom('app_user')
      .select(['id', 'display_name'])
      .where('id', 'in', [...new Set(docs.map((d) => d.created_by))])
      .execute();
    const names = new Map(uploaders.map((u) => [u.id, u.display_name]));
    return docs.map((d) => ({
      id: d.id,
      clientId: d.client_id,
      installationId: d.installation_id,
      title: d.title,
      docType: d.doc_type as EvidenceDocType,
      documentDate: d.document_date,
      fileName: d.file_name,
      contentType: d.content_type as EvidenceContentType,
      bytes: Number(d.bytes),
      sha256: d.sha256,
      uploadedAt: d.created_at.toISOString(),
      uploadedById: d.created_by,
      uploadedBy: names.get(d.created_by) ?? null,
      locked: lockedIds.has(d.id),
      links: links
        .filter((l) => l.evidence_id === d.id)
        .map((l) => ({
          id: l.id,
          recordType: l.record_table as EvidenceRecordType,
          recordId: l.record_id,
          createdById: l.created_by,
          label: labels.get(labelKey(l.record_table as EvidenceRecordType, l.record_id)) ?? null,
          locked: l.status === 'approved' || l.status === 'issued',
        })),
    }));
  };

  const insertLink = (tx: Tx, doc: { id: string; tenant_id: string; client_id: string }, ref: EvidenceRecordRef) =>
    tx
      .insertInto('evidence_link')
      .values({ tenant_id: doc.tenant_id, client_id: doc.client_id, evidence_id: doc.id, record_table: ref.recordType, record_id: ref.recordId } as never)
      .execute()
      .catch(mapEvidenceDbError);

  // --- upload (M13-R2, R3) ----------------------------------------------------------

  router.post(
    '/clients/:id/evidence',
    upload,
    // The file is the raw body; metadata comes in the query string. Oversize files get the
    // design system 5.9 wording, not the generic one (review M13 F5).
    (req, res, next) =>
      rawBody(req, res, (err?: { type?: string }) =>
        err?.type === 'entity.too.large'
          ? next(new AppError(413, 'too_large', 'Files over 25 MB aren’t accepted. Split or compress the file.'))
          : next(err),
      ),
    async (req, res) => {
      const clientId = idParam(req.params.id, 'client');
      const q = EvidenceUploadQuery.parse(req.query);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const contentType = checkEvidenceFile(q.fileName, body);
      const role = req.auth!.user.role;
      if (role === 'contributor' && !q.installationId) {
        throw new AppError(400, 'validation_failed', 'Choose the installation this file belongs to.', undefined, [
          { path: ['installationId'], message: 'Choose the installation this file belongs to.' },
        ]);
      }
      const ctx = contextOf(req, 'Upload evidence');

      // Access and duplicates first, so nothing is stored for a request that will fail.
      const client = await withContext(db, contextOf(req), async (tx) => {
        const c = await tx.selectFrom('client').select(['id', 'tenant_id']).where('id', '=', clientId).where('deleted_at', 'is', null).executeTakeFirst();
        if (!c) throw notFound('client');
        if (q.installationId) {
          const i = await tx
            .selectFrom('installation')
            .select('id')
            .where('id', '=', q.installationId)
            .where('client_id', '=', clientId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (!i) throw notFound('installation');
        }
        await assertNotDuplicate(tx, clientId, sha256Of(body));
        return c;
      });

      const stored = await files.put({ folder: `${client.tenant_id}/${clientId}/evidence`, fileName: q.fileName, body });
      try {
        const evidence = await withContext(db, ctx, async (tx) => {
          await assertNotDuplicate(tx, clientId, stored.sha256); // again: another upload may have won the race
          const doc = await tx
            .insertInto('evidence_document')
            .values({
              tenant_id: ctx.tenantId,
              client_id: clientId,
              installation_id: q.installationId ?? null,
              title: q.title ?? q.fileName,
              doc_type: q.docType,
              document_date: q.documentDate ?? null,
              file_name: q.fileName,
              content_type: contentType,
              bytes: String(stored.bytes),
              sha256: stored.sha256,
              storage_key: stored.key,
            } as never)
            .returningAll()
            .executeTakeFirstOrThrow()
            .catch((e: { code?: string; constraint?: string }) => {
              // A file the caller cannot see (another installation) with the same content.
              if (e.code === '23505' && e.constraint === 'evidence_document_unique_file') {
                throw new AppError(409, 'duplicate', 'This file is already in the evidence library.');
              }
              throw e;
            });
          if (q.recordType && q.recordId) await insertLink(tx, doc, { recordType: q.recordType, recordId: q.recordId });
          return (await summaries(tx, [doc]))[0]!;
        });
        res.status(201).json({ evidence });
      } catch (e) {
        await files.delete(stored.key).catch(() => undefined); // best effort: no orphan files
        throw e;
      }
    },
  );

  // --- list and read ------------------------------------------------------------------

  router.get('/clients/:id/evidence', async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const filter = z
      .object({ installationId: z.uuid().optional(), recordType: z.string().optional(), periodVersionId: z.uuid().optional() })
      .parse(req.query);
    const evidence = await withContext(db, contextOf(req), async (tx) => {
      const c = await tx.selectFrom('client').select('id').where('id', '=', clientId).where('deleted_at', 'is', null).executeTakeFirst();
      if (!c) throw notFound('client');
      let q = tx.selectFrom('evidence_document as d').selectAll('d').where('d.client_id', '=', clientId).where('d.deleted_at', 'is', null);
      if (filter.installationId) q = q.where('d.installation_id', '=', filter.installationId);
      if (filter.recordType || filter.periodVersionId) {
        q = q.where((eb) =>
          eb.exists(
            eb
              .selectFrom('evidence_link as l')
              .select('l.id')
              .whereRef('l.evidence_id', '=', 'd.id')
              .$if(!!filter.recordType, (w) => w.where('l.record_table', '=', filter.recordType!))
              .$if(!!filter.periodVersionId, (w) => w.where('l.period_version_id', '=', filter.periodVersionId!)),
          ),
        );
      }
      return summaries(tx, await q.orderBy('d.created_at', 'desc').limit(500).execute());
    });
    res.json({ evidence });
  });

  // Evidence supporting one record (the evidence panel on a record's screen).
  router.get('/records/:type/:id/evidence', async (req, res) => {
    const ref = EvidenceRecordRef.safeParse({ recordType: req.params.type, recordId: req.params.id });
    if (!ref.success) throw notFound('record');
    const evidence = await withContext(db, contextOf(req), async (tx) => {
      const docs = await tx
        .selectFrom('evidence_document as d')
        .innerJoin('evidence_link as l', 'l.evidence_id', 'd.id')
        .selectAll('d')
        .where('l.record_table', '=', ref.data.recordType)
        .where('l.record_id', '=', ref.data.recordId)
        .where('d.deleted_at', 'is', null)
        .orderBy('d.created_at', 'desc')
        .execute();
      return summaries(tx, docs);
    });
    res.json({ evidence });
  });

  router.get('/evidence/:id', async (req, res) => {
    const id = idParam(req.params.id, 'evidence');
    const evidence = await withContext(db, contextOf(req), async (tx) => (await summaries(tx, [await loadEvidence(tx, id)]))[0]);
    res.json({ evidence });
  });

  // M13-R2: a signed link that stops working after 5 minutes; only for visible evidence.
  router.get('/evidence/:id/download', async (req, res) => {
    const id = idParam(req.params.id, 'evidence');
    const doc = await withContext(db, contextOf(req), (tx) => loadEvidence(tx, id));
    const url = files.signedDownloadUrl(doc.storage_key, { expiresInSeconds: DOWNLOAD_LINK_SECONDS });
    res.set('Cache-Control', 'no-store').json({ url, expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000).toISOString() });
  });

  // --- edit and delete (M13-R4) ------------------------------------------------------------

  const canEdit = (role: string, doc: DocRow, userId: string) =>
    can(role as never, 'evidence.manage') || (role === 'contributor' && doc.created_by === userId);

  router.patch('/evidence/:id', upload, async (req, res) => {
    const id = idParam(req.params.id, 'evidence');
    const patch = EvidencePatch.parse(req.body);
    const evidence = await withContext(db, contextOf(req, 'Edit evidence'), async (tx) => {
      const doc = await loadEvidence(tx, id);
      if (!canEdit(req.auth!.user.role, doc, req.auth!.user.id)) throw new AppError(403, 'forbidden', 'You can edit only the files you uploaded.');
      const row = await tx
        .updateTable('evidence_document')
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.docType !== undefined && { doc_type: patch.docType }),
          ...(patch.documentDate !== undefined && { document_date: patch.documentDate }),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch(mapEvidenceDbError);
      return (await summaries(tx, [row]))[0];
    });
    res.json({ evidence });
  });

  // Soft delete: the file stays in storage and in the audit trail.
  router.delete('/evidence/:id', upload, async (req, res) => {
    const id = idParam(req.params.id, 'evidence');
    await withContext(db, contextOf(req, 'Delete evidence'), async (tx) => {
      const doc = await loadEvidence(tx, id);
      if (!canEdit(req.auth!.user.role, doc, req.auth!.user.id)) throw new AppError(403, 'forbidden', 'You can delete only the files you uploaded.');
      await tx.updateTable('evidence_document').set({ deleted_at: sql`now()` }).where('id', '=', id).execute().catch(mapEvidenceDbError);
    });
    res.status(204).end();
  });

  // --- links (M13-R1) ---------------------------------------------------------------------

  router.post('/evidence/:id/links', upload, async (req, res) => {
    const id = idParam(req.params.id, 'evidence');
    const ref = EvidenceRecordRef.parse(req.body);
    const evidence = await withContext(db, contextOf(req, 'Link evidence'), async (tx) => {
      const doc = await loadEvidence(tx, id);
      await insertLink(tx, doc, ref);
      return (await summaries(tx, [doc]))[0];
    });
    res.status(201).json({ evidence });
  });

  router.delete('/evidence/:id/links/:linkId', upload, async (req, res) => {
    const id = idParam(req.params.id, 'evidence');
    const linkId = idParam(req.params.linkId, 'link');
    await withContext(db, contextOf(req, 'Unlink evidence'), async (tx) => {
      await loadEvidence(tx, id);
      if (!can(req.auth!.user.role, 'evidence.manage')) {
        const link = await tx.selectFrom('evidence_link').select('created_by').where('id', '=', linkId).where('evidence_id', '=', id).executeTakeFirst();
        if (link && link.created_by !== req.auth!.user.id) {
          throw new AppError(403, 'forbidden', 'You can remove only the links you made.');
        }
      }
      const deleted = await tx
        .deleteFrom('evidence_link')
        .where('id', '=', linkId)
        .where('evidence_id', '=', id)
        .executeTakeFirst()
        .catch(mapEvidenceDbError);
      if (Number(deleted.numDeletedRows) === 0) throw notFound('link');
    });
    res.status(204).end();
  });

  return router;
}

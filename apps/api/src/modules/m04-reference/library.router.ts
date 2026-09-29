import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler, Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  type CnCodeRow,
  CreateLibraryVersionRequest,
  FactorFields,
  FactorInput,
  FactorKind,
  FactorPatch,
  GoodsCategoryPatch,
  type ImportPreview,
  type ImportRowError,
  ImportRequest,
  type LibraryVersionSummary,
  PublishRequest,
  RelevantPrecursorsRequest,
  type TemplateVersionEntry,
  can,
} from '@cbam/shared';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { mapDbError } from '../../platform/db-errors';
import { type Db, type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import {
  checkDefaultValues,
  cnRecord,
  currentVersion,
  datasetState,
  diffFingerprint,
  diffVersions,
  factorColumns,
  factorDto,
  factorRowRecord,
  loadCnCodes,
  loadDraft,
  loadFactors,
  loadGoods,
  loadVersion,
  notFound,
} from './data';
import { diffRecords } from './diff';
import { type FactorRow, parseImport, withSi } from './import';

const Id = z.uuid();
const idParam = (raw: unknown, what: string): string => {
  const r = Id.safeParse(raw);
  if (!r.success) throw notFound(what);
  return r.data;
};

const VERSION_UNIQUE = {
  library_version_code_key: 'A library version with this code already exists.',
  // Two admins creating a draft at once (review M4 F7).
  library_version_one_draft: 'Another draft version was just created. Open it, or discard it first.',
};
const FACTOR_UNIQUE = {
  library_factor_unique_key:
    'This version already has a factor for this kind, subject, country, region, year and component.',
};

/**
 * M4 — reference library. Every role reads (decision D1); only the platform admin changes
 * a draft, imports files and publishes (M4-R5, AT3). Published versions are immutable
 * (M4-R2): the API refuses first, the database trigger holds if it does not.
 */
export function libraryRouter({ db }: { db: Db }): Router {
  const router = Router();
  router.use('/library', requireAuth);

  /** Platform admin of the operator tenant (decision D12); RLS checks the same (app.is_library_admin). */
  const isLibraryAdmin = async (req: Request) =>
    can(req.auth!.user.role, 'library.write') &&
    (await withContext(db, contextOf(req), (tx) =>
      tx.selectFrom('tenant').select('is_platform_operator').where('id', '=', req.auth!.user.tenantId).executeTakeFirst(),
    ))?.is_platform_operator === true;
  const requireOperator: RequestHandler = async (req, _res, next) => {
    if (await isLibraryAdmin(req)) return next();
    next(new AppError(403, 'forbidden', 'Only platform admins of the platform operator can change the reference library.'));
  };
  const write = [requirePermission('library.write'), requireOperator];

  const versionSummary = async (tx: Tx): Promise<LibraryVersionSummary[]> => {
    const current = await currentVersion(tx);
    const rows = await tx
      .selectFrom('library_version as v')
      .leftJoin('library_version as b', 'b.id', 'v.based_on_id')
      .select([
        'v.id',
        'v.code',
        'v.status',
        'v.notes',
        'v.published_at',
        'v.created_at',
        'b.code as based_on_code',
        (eb) => eb.selectFrom('library_factor as f').whereRef('f.library_version_id', '=', 'v.id').select(eb.fn.countAll<string>().as('n')).as('factors'),
        (eb) => eb.selectFrom('cn_code as c').whereRef('c.library_version_id', '=', 'v.id').select(eb.fn.countAll<string>().as('n')).as('cn_codes'),
        (eb) => eb.selectFrom('goods_category as g').whereRef('g.library_version_id', '=', 'v.id').select(eb.fn.countAll<string>().as('n')).as('goods'),
      ])
      .orderBy(sql`v.status = 'draft'`, 'desc')
      .orderBy('v.published_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status as 'draft' | 'published',
      basedOnCode: r.based_on_code,
      notes: r.notes,
      publishedAt: r.published_at?.toISOString() ?? null,
      isCurrent: r.id === current?.id,
      createdAt: r.created_at.toISOString(),
      counts: { factors: Number(r.factors ?? 0), cnCodes: Number(r.cn_codes ?? 0), goodsCategories: Number(r.goods ?? 0) },
    }));
  };

  // --- versions (M4-R2, R3) ----------------------------------------------------

  router.get('/library/versions', async (req, res) => {
    const versions = await withContext(db, contextOf(req), versionSummary);
    res.json({ versions, canEdit: await isLibraryAdmin(req) });
  });

  /** The version a new period pins (M3 calls the same lookup). */
  router.get('/library/versions/current', async (req, res) => {
    const versions = await withContext(db, contextOf(req), versionSummary);
    const current = versions.find((v) => v.isCurrent);
    if (!current) throw notFound('library version');
    res.json({ version: current });
  });

  router.post('/library/versions', ...write, async (req, res) => {
    const input = CreateLibraryVersionRequest.parse(req.body);
    const ctx = contextOf(req, 'Create draft version');
    const id = await withContext(db, ctx, async (tx) => {
      const draft = await tx.selectFrom('library_version').select('code').where('status', '=', 'draft').executeTakeFirst();
      if (draft) throw new AppError(409, 'draft_exists', `Draft version ${draft.code} is open. Publish or discard it first.`);
      const base = await currentVersion(tx);
      const created = await tx
        .insertInto('library_version')
        .values({ code: input.code, notes: input.notes ?? null, based_on_id: base?.id ?? null })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, VERSION_UNIQUE));
      if (base) await sql`select app.clone_library_content(${base.id}, ${created.id})`.execute(tx);
      return created.id;
    });
    const versions = await withContext(db, contextOf(req), versionSummary);
    res.status(201).json({ version: versions.find((v) => v.id === id) });
  });

  router.delete('/library/versions/:id', ...write, async (req, res) => {
    const id = idParam(req.params.id, 'library version');
    await withContext(db, contextOf(req, 'Discard draft'), async (tx) => {
      await loadDraft(tx, id);
      await tx.deleteFrom('library_version').where('id', '=', id).execute();
    });
    res.status(204).end();
  });

  /** Publish preview: what changes against the version it was based on (design system 6.12). */
  router.get('/library/versions/:id/diff', async (req, res) => {
    const id = idParam(req.params.id, 'library version');
    const diff = await withContext(db, contextOf(req), async (tx) => {
      const v = await loadVersion(tx, id);
      return diffVersions(tx, v.based_on_id, v.id);
    });
    res.json({ diff, fingerprint: diffFingerprint(diff) });
  });

  router.post('/library/versions/:id/publish', ...write, async (req, res) => {
    const id = idParam(req.params.id, 'library version');
    const { confirmCode, diffFingerprint: reviewed } = PublishRequest.parse(req.body);
    await withContext(db, contextOf(req, 'Publish version'), async (tx) => {
      const v = await loadDraft(tx, id); // locks the draft: no edit can land between check and publish
      if (confirmCode !== v.code) {
        throw new AppError(400, 'validation_failed', 'Some fields are not valid. Fix them and try again.', undefined, [
          { path: ['confirmCode'], message: `Type ${v.code} to confirm.` },
        ]);
      }
      // Publish exactly what the admin reviewed (review M4 F1).
      if (diffFingerprint(await diffVersions(tx, v.based_on_id, v.id)) !== reviewed) {
        throw new AppError(409, 'stale_diff', 'The draft changed after you opened this review. Check the changes again before publishing.');
      }
      await tx.updateTable('library_version').set({ status: 'published' }).where('id', '=', id).execute();
    });
    const versions = await withContext(db, contextOf(req), versionSummary);
    res.json({ version: versions.find((x) => x.id === id) });
  });

  // --- content (read) --------------------------------------------------------

  router.get('/library/versions/:id/factors', async (req, res) => {
    const id = idParam(req.params.id, 'library version');
    const kind = req.query.kind === undefined ? undefined : FactorKind.parse(req.query.kind);
    const rows = await withContext(db, contextOf(req), async (tx) => {
      await loadVersion(tx, id);
      return loadFactors(tx, id);
    });
    res.json({ factors: rows.filter((r) => !kind || r.kind === kind).map(factorDto) });
  });

  router.get('/library/versions/:id/cn-codes', async (req, res) => {
    const id = idParam(req.params.id, 'library version');
    const cnCodes = await withContext(db, contextOf(req), async (tx) => {
      await loadVersion(tx, id);
      return loadCnCodes(tx, id);
    });
    res.json({ cnCodes });
  });

  router.get('/library/versions/:id/goods', async (req, res) => {
    const id = idParam(req.params.id, 'library version');
    const goods = await withContext(db, contextOf(req), async (tx) => {
      await loadVersion(tx, id);
      return loadGoods(tx, id);
    });
    res.json({ goods });
  });

  router.get('/library/templates', async (req, res) => {
    const rows = await withContext(db, contextOf(req), (tx) =>
      tx.selectFrom('template_version').selectAll().orderBy('released_on', 'desc').execute(),
    );
    const templates: TemplateVersionEntry[] = rows.map((t) => ({
      code: t.code,
      title: t.title,
      fileName: t.file_name,
      fileSha256: t.file_sha256,
      releasedOn: t.released_on,
    }));
    res.json({ templates });
  });

  // --- factors in a draft (M4-R1, R6, R8) ---------------------------------------

  const loadFactor = async (tx: Tx, id: string) => {
    const row = await tx.selectFrom('library_factor').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('factor');
    return row;
  };

  const assertDefaultValue = async (tx: Tx, versionId: string, f: { kind: string; subject: string; unit: string }) => {
    const p = (await checkDefaultValues(tx, versionId, [f])).get(0);
    if (p) throw new AppError(400, 'validation_failed', 'Some fields are not valid. Fix them and try again.', undefined, [{ path: [p.field], message: p.message }]);
  };

  router.post('/library/versions/:id/factors', ...write, async (req, res) => {
    const versionId = idParam(req.params.id, 'library version');
    const input = withSi(FactorInput.parse(req.body));
    const row = await withContext(db, contextOf(req, 'Add factor'), async (tx) => {
      await loadDraft(tx, versionId);
      await assertDefaultValue(tx, versionId, input);
      return tx
        .insertInto('library_factor')
        .values({ library_version_id: versionId, ...factorColumns(input) })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, FACTOR_UNIQUE));
    });
    res.status(201).json({ factor: factorDto(row) });
  });

  router.patch('/library/factors/:id', ...write, async (req, res) => {
    const id = idParam(req.params.id, 'factor');
    const patch = FactorPatch.parse(req.body);
    const row = await withContext(db, contextOf(req, 'Save factor'), async (tx) => {
      const current = await loadFactor(tx, id);
      await loadDraft(tx, current.library_version_id);
      const existing = factorDto(current);
      // The whole record must stay valid (per-kind rules on the merged record).
      const merged = withSi(FactorInput.parse({ ...FactorFields.parse(existing), ...patch }));
      await assertDefaultValue(tx, current.library_version_id, merged);
      return tx
        .updateTable('library_factor')
        .set(factorColumns(merged))
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, FACTOR_UNIQUE));
    });
    res.json({ factor: factorDto(row) });
  });

  router.delete('/library/factors/:id', ...write, async (req, res) => {
    const id = idParam(req.params.id, 'factor');
    await withContext(db, contextOf(req, 'Delete factor'), async (tx) => {
      const f = await loadFactor(tx, id);
      await loadDraft(tx, f.library_version_id);
      await tx.deleteFrom('library_factor').where('id', '=', id).execute();
    });
    res.status(204).end();
  });

  // --- regulatory configuration (M4-R7) ------------------------------------------

  const loadCategory = async (tx: Tx, id: string) => {
    const row = await tx.selectFrom('goods_category').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('goods category');
    await loadDraft(tx, row.library_version_id);
    return row;
  };

  router.patch('/library/goods-categories/:id', ...write, async (req, res) => {
    const id = idParam(req.params.id, 'goods category');
    const patch = GoodsCategoryPatch.parse(req.body);
    await withContext(db, contextOf(req, 'Save goods category'), async (tx) => {
      await loadCategory(tx, id);
      await tx
        .updateTable('goods_category')
        .set({
          ...(patch.indirectRelevantDefinitive !== undefined && { indirect_relevant_definitive: patch.indirectRelevantDefinitive }),
          ...(patch.indirectRelevantTransitional !== undefined && { indirect_relevant_transitional: patch.indirectRelevantTransitional }),
        })
        .where('id', '=', id)
        .execute();
    });
    res.status(204).end();
  });

  router.put('/library/goods-categories/:id/precursors', ...write, async (req, res) => {
    const id = idParam(req.params.id, 'goods category');
    const { precursors } = RelevantPrecursorsRequest.parse(req.body);
    await withContext(db, contextOf(req, 'Save relevant precursors'), async (tx) => {
      const cat = await loadCategory(tx, id);
      const goods = await loadGoods(tx, cat.library_version_id);
      const self = goods.find((g) => g.code === cat.code)!;
      const issues = precursors.flatMap((p, i) => [
        ...(goods.some((g) => g.code === p.precursorCode) && p.precursorCode !== cat.code
          ? []
          : [{ path: ['precursors', i, 'precursorCode'], message: 'Choose another goods category as the precursor.' }]),
        ...(p.routeCode === null || self.routes.some((r) => r.code === p.routeCode)
          ? []
          : [{ path: ['precursors', i, 'routeCode'], message: `Choose one of this category’s routes, or all routes.` }]),
      ]);
      if (issues.length) throw new AppError(400, 'validation_failed', 'Some fields are not valid. Fix them and try again.', undefined, issues);
      await tx
        .deleteFrom('route_relevant_precursor')
        .where('library_version_id', '=', cat.library_version_id)
        .where('goods_category_code', '=', cat.code)
        .execute();
      if (precursors.length) {
        await tx
          .insertInto('route_relevant_precursor')
          .values(
            precursors.map((p) => ({
              library_version_id: cat.library_version_id,
              goods_category_code: cat.code,
              route_code: p.routeCode,
              precursor_category_code: p.precursorCode,
            })),
          )
          .execute()
          .catch((e) => mapDbError(e, { route_relevant_precursor_unique_key: 'A precursor is listed twice.' }));
      }
    });
    res.status(204).end();
  });

  // --- import (M4-R4, AT2) -----------------------------------------------------

  const rejected = (errors: ImportRowError[]) =>
    new AppError(
      400,
      'import_rejected',
      errors.length === 1
        ? `The file was not imported: line ${errors[0]!.row} has an error. Fix it and upload the file again.`
        : `The file was not imported: ${errors.length} errors. Fix them and upload the file again.`,
      { errors },
    );

  /** Checks that need the draft: countries exist, goods categories exist. */
  const checkReferences = async (tx: Tx, versionId: string, parsed: { dataset: 'factors'; rows: FactorRow[] } | { dataset: 'cn_codes'; rows: CnCodeRow[] }, lines: number[]) => {
    const errors: ImportRowError[] = [];
    if (parsed.dataset === 'factors') {
      const countries = new Set((await tx.selectFrom('ref_country').select('code').execute()).map((c) => c.code.trimEnd()));
      parsed.rows.forEach((r, i) => {
        if (r.countryCode && !countries.has(r.countryCode)) {
          errors.push({ row: lines[i]!, column: 'country_code', message: `"${r.countryCode}" is not a country code in the list.` });
        }
      });
      for (const [i, p] of await checkDefaultValues(tx, versionId, parsed.rows)) {
        errors.push({ row: lines[i]!, column: p.field, message: p.message });
      }
      errors.sort((a, b) => a.row - b.row);
    } else {
      const cats = new Set(
        (await tx.selectFrom('goods_category').select('code').where('library_version_id', '=', versionId).execute()).map((c) => c.code),
      );
      parsed.rows.forEach((r, i) => {
        if (!cats.has(r.goodsCategoryCode)) {
          errors.push({ row: lines[i]!, column: 'goods_category', message: `"${r.goodsCategoryCode}" is not a goods category code in this version.` });
        }
      });
    }
    return errors;
  };

  /** Records the import would replace: every CN code, or the factor kinds present in the file. */
  const importScope = async (tx: Tx, versionId: string, dataset: 'factors' | 'cn_codes', kinds: Set<string>) => {
    const { records, fingerprint } = await datasetState(tx, versionId, dataset);
    const inScope = dataset === 'factors' ? records.filter((r) => kinds.has(r.key.split('|')[0]!)) : records;
    return { inScope, fingerprint };
  };

  router.post('/library/versions/:id/imports', ...write, express.json({ limit: '10mb' }), async (req, res) => {
    const versionId = idParam(req.params.id, 'library version');
    const input = ImportRequest.parse(req.body);
    const parsed = parseImport(input.dataset, input.content);
    if (!parsed.ok) throw rejected(parsed.errors);

    const preview = await withContext(db, contextOf(req, 'Check file'), async (tx) => {
      await loadDraft(tx, versionId);
      const refErrors = await checkReferences(tx, versionId, parsed, parsed.lines);
      if (refErrors.length) throw rejected(refErrors);

      const kinds = new Set(parsed.dataset === 'factors' ? parsed.rows.map((r) => r.kind) : []);
      const { inScope, fingerprint } = await importScope(tx, versionId, parsed.dataset, kinds);
      const incoming = parsed.dataset === 'factors' ? parsed.rows.map(factorRowRecord) : parsed.rows.map(cnRecord);
      const diff = diffRecords(inScope, incoming);
      const row = await tx
        .insertInto('library_import')
        .values({
          library_version_id: versionId,
          dataset: parsed.dataset,
          file_name: input.fileName,
          file_sha256: createHash('sha256').update(input.content).digest('hex'),
          row_count: parsed.rows.length,
          base_fingerprint: fingerprint,
          summary: JSON.stringify({ added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, kinds: [...kinds] }),
          rows: JSON.stringify(parsed.rows),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: row.id, dataset: parsed.dataset, fileName: input.fileName, rowCount: parsed.rows.length, diff } satisfies ImportPreview;
    });
    res.status(201).json({ preview });
  });

  router.post('/library/imports/:id/apply', ...write, async (req, res) => {
    const id = idParam(req.params.id, 'import');
    const ctx = contextOf(req, 'Apply to draft');
    const result = await withContext(db, ctx, async (tx) => {
      const imp = await tx.selectFrom('library_import').selectAll().where('id', '=', id).executeTakeFirst();
      if (!imp) throw notFound('import');
      if (imp.status === 'applied') throw new AppError(409, 'already_applied', 'This import has already been applied.');
      await loadDraft(tx, imp.library_version_id);
      const dataset = imp.dataset as 'factors' | 'cn_codes';
      const summary = imp.summary as { kinds: string[] };
      const { fingerprint } = await importScope(tx, imp.library_version_id, dataset, new Set(summary.kinds));
      if (fingerprint !== imp.base_fingerprint) {
        throw new AppError(409, 'stale_preview', 'The draft changed after this file was checked. Upload the file again to see the current differences.');
      }
      if (dataset === 'factors') {
        const rows = imp.rows as FactorRow[];
        await tx
          .deleteFrom('library_factor')
          .where('library_version_id', '=', imp.library_version_id)
          .where('kind', 'in', summary.kinds)
          .execute();
        for (const chunk of chunks(rows, 500)) {
          await tx
            .insertInto('library_factor')
            .values(chunk.map((r) => ({ library_version_id: imp.library_version_id, ...factorColumns(r) })))
            .execute();
        }
      } else {
        const rows = imp.rows as CnCodeRow[];
        await tx.deleteFrom('cn_code').where('library_version_id', '=', imp.library_version_id).execute();
        for (const chunk of chunks(rows, 500)) {
          await tx
            .insertInto('cn_code')
            .values(chunk.map((r) => ({ library_version_id: imp.library_version_id, code: r.code, description: r.description, goods_category_code: r.goodsCategoryCode })))
            .execute();
        }
      }
      await tx.updateTable('library_import').set({ status: 'applied', applied_at: sql`now()` }).where('id', '=', id).execute();
      return { rowCount: imp.row_count };
    });
    res.json(result);
  });

  return router;
}

function* chunks<T>(rows: T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

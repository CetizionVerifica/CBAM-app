import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  ClientInput,
  ClientPatch,
  type ClientSummary,
  ImporterInput,
  ImporterPatch,
  InstallationInput,
  InstallationPatch,
  type TeamMember,
  type UserRole,
} from '@cbam/shared';
import { contextOf, requireAuth, requirePermission } from '../../platform/auth';
import { mapDbError } from '../../platform/db-errors';
import { type Db, type Tx, withContext } from '../../platform/db';
import { AppError } from '../../platform/errors';
import { CLIENT_COLUMNS, IMPORTER_COLUMNS, INSTALLATION_COLUMNS, fromRow, toRow } from './fields';

const Id = z.uuid();

const idParam = (raw: unknown, what: string): string => {
  const r = Id.safeParse(raw);
  if (!r.success) throw notFound(what);
  return r.data;
};

const notFound = (what: string) => new AppError(404, 'not_found', `This ${what} does not exist or you do not have access to it.`);

// M2-R5 duplicate messages, keyed by unique index name.
const CLIENT_UNIQUE = { client_unique_name: 'A client with this legal name already exists in this country.' };
const INSTALLATION_UNIQUE = { installation_unique_name: 'This client already has an installation with this name.' };
const IMPORTER_UNIQUE = { eu_importer_unique_eori: 'This client already has an importer with this EORI number.' };

/**
 * M2 — client and installation registry: clients, installations, EU importers, and who is
 * assigned to them. Every query runs under the caller's context, so row-level security
 * decides what exists for them (G1); records they cannot access answer 404.
 */
export function registryRouter({ db }: { db: Db }): Router {
  const router = Router();
  router.use(['/clients', '/installations', '/importers', '/reference'], requireAuth);

  // --- loaders (RLS-filtered; soft-deleted rows count as gone) ---------------

  const loadClient = async (tx: Tx, id: string) => {
    const row = await tx.selectFrom('client').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw notFound('client');
    return row;
  };
  const loadInstallation = async (tx: Tx, id: string) => {
    const row = await tx.selectFrom('installation').selectAll().where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw notFound('installation');
    return row;
  };
  // The parent client must be live too: a deleted client's importers are gone (review M2 F2).
  const loadImporter = async (tx: Tx, id: string) => {
    const row = await tx
      .selectFrom('eu_importer as e')
      .innerJoin('client as c', 'c.id', 'e.client_id')
      .selectAll('e')
      .where('e.id', '=', id)
      .where('e.deleted_at', 'is', null)
      .where('c.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw notFound('importer');
    return row;
  };

  const clientDto = (r: { id: string; updated_at: Date } & Record<string, unknown>) => ({
    id: r.id,
    ...fromRow(r, CLIENT_COLUMNS),
    updatedAt: r.updated_at.toISOString(),
  });
  const installationDto = (r: { id: string; client_id: string; updated_at: Date } & Record<string, unknown>) => ({
    id: r.id,
    clientId: r.client_id,
    ...fromRow(r, INSTALLATION_COLUMNS),
    updatedAt: r.updated_at.toISOString(),
  });
  const importerDto = (r: { id: string; client_id: string } & Record<string, unknown>) => ({
    id: r.id,
    clientId: r.client_id,
    ...fromRow(r, IMPORTER_COLUMNS),
  });

  // --- clients -------------------------------------------------------------

  router.get('/clients', async (req, res) => {
    const rows = await withContext(db, contextOf(req), (tx) =>
      tx
        .selectFrom('client as c')
        .leftJoin('installation as i', (j) => j.onRef('i.client_id', '=', 'c.id').on('i.deleted_at', 'is', null))
        .select(['c.id', 'c.legal_name', 'c.country_code', 'c.city', (eb) => eb.fn.count<string>('i.id').as('installations')])
        .where('c.deleted_at', 'is', null)
        .groupBy('c.id')
        .orderBy('c.legal_name')
        .execute(),
    );
    const clients: ClientSummary[] = rows.map((r) => ({
      id: r.id,
      legalName: r.legal_name,
      countryCode: r.country_code.trimEnd(),
      city: r.city,
      installationCount: Number(r.installations),
    }));
    res.json({ clients });
  });

  router.post('/clients', requirePermission('registry.write'), async (req, res) => {
    const input = ClientInput.parse(req.body);
    const ctx = contextOf(req, 'Add client');
    const id = randomUUID();
    const client = await withContext(db, ctx, async (tx) => {
      // No RETURNING: a consultant can read the row only after the creator assignment
      // (an AFTER INSERT trigger) exists.
      await tx
        .insertInto('client')
        .values({ id, tenant_id: ctx.tenantId, ...toRow(input, CLIENT_COLUMNS) } as never)
        .execute()
        .catch((e) => mapDbError(e, CLIENT_UNIQUE));
      return loadClient(tx, id);
    });
    res.status(201).json({ client: clientDto(client) });
  });

  router.get('/clients/:id', async (req, res) => {
    const id = idParam(req.params.id, 'client');
    const result = await withContext(db, contextOf(req), async (tx) => {
      const client = await loadClient(tx, id);
      const installations = await tx
        .selectFrom('installation')
        .selectAll()
        .where('client_id', '=', id)
        .where('deleted_at', 'is', null)
        .orderBy('name_en')
        .execute();
      const importers = await tx
        .selectFrom('eu_importer')
        .selectAll()
        .where('client_id', '=', id)
        .where('deleted_at', 'is', null)
        .orderBy('name')
        .execute();
      return { client, installations, importers };
    });
    res.json({
      client: clientDto(result.client),
      installations: result.installations.map(installationDto),
      importers: result.importers.map(importerDto),
    });
  });

  router.patch('/clients/:id', requirePermission('registry.write'), async (req, res) => {
    const id = idParam(req.params.id, 'client');
    const patch = ClientPatch.parse(req.body);
    const client = await withContext(db, contextOf(req, 'Edit client'), async (tx) => {
      const existing = await loadClient(tx, id);
      ClientInput.parse({ ...fromRow(existing, CLIENT_COLUMNS), ...patch }); // whole record still valid
      return tx
        .updateTable('client')
        .set(toRow(patch, CLIENT_COLUMNS) as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, CLIENT_UNIQUE));
    });
    res.json({ client: clientDto(client) });
  });

  // M2-R6: soft delete only. A client with live installations keeps them visible to
  // nobody, so those go first.
  router.delete('/clients/:id', requirePermission('registry.write'), async (req, res) => {
    const id = idParam(req.params.id, 'client');
    await withContext(db, contextOf(req, 'Delete client'), async (tx) => {
      await loadClient(tx, id);
      const live = await tx
        .selectFrom('installation')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('client_id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(live.n) > 0) {
        throw new AppError(409, 'has_installations', `Delete this client’s ${live.n} installation(s) first.`);
      }
      await tx.updateTable('client').set({ deleted_at: sql`now()` }).where('id', '=', id).execute();
    });
    res.status(204).end();
  });

  // --- installations -------------------------------------------------------

  router.post('/clients/:id/installations', requirePermission('registry.write'), async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const input = InstallationInput.parse(req.body);
    const ctx = contextOf(req, 'Add installation');
    const installation = await withContext(db, ctx, async (tx) => {
      await loadClient(tx, clientId);
      return tx
        .insertInto('installation')
        .values({ tenant_id: ctx.tenantId, client_id: clientId, ...toRow(input, INSTALLATION_COLUMNS) } as never)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, INSTALLATION_UNIQUE));
    });
    res.status(201).json({ installation: installationDto(installation) });
  });

  router.get('/installations/:id', async (req, res) => {
    const id = idParam(req.params.id, 'installation');
    const installation = await withContext(db, contextOf(req), (tx) => loadInstallation(tx, id));
    res.json({ installation: installationDto(installation) });
  });

  router.patch('/installations/:id', requirePermission('registry.write'), async (req, res) => {
    const id = idParam(req.params.id, 'installation');
    const patch = InstallationPatch.parse(req.body);
    const installation = await withContext(db, contextOf(req, 'Edit installation'), async (tx) => {
      const existing = await loadInstallation(tx, id);
      // Cross-field rules (UN/LOCODE vs country, coordinate pair) on the merged record.
      InstallationInput.parse({ ...fromRow(existing, INSTALLATION_COLUMNS), ...patch });
      return tx
        .updateTable('installation')
        .set(toRow(patch, INSTALLATION_COLUMNS) as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, INSTALLATION_UNIQUE));
    });
    res.json({ installation: installationDto(installation) });
  });

  // M2-R6, AT3: soft delete, and never for an installation with reporting periods (the
  // database refuses too).
  router.delete('/installations/:id', requirePermission('registry.write'), async (req, res) => {
    const id = idParam(req.params.id, 'installation');
    await withContext(db, contextOf(req, 'Delete installation'), async (tx) => {
      await loadInstallation(tx, id);
      const periods = await tx
        .selectFrom('reporting_period')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('installation_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(periods.n) > 0) {
        throw new AppError(
          409,
          'has_periods',
          `This installation has ${periods.n} reporting period(s), so it can't be deleted. Its data must stay available for verification.`,
        );
      }
      await tx.updateTable('installation').set({ deleted_at: sql`now()` }).where('id', '=', id).execute();
      await tx.deleteFrom('user_installation_assignment').where('installation_id', '=', id).execute();
    });
    res.status(204).end();
  });

  // --- EU importers --------------------------------------------------------

  router.post('/clients/:id/importers', requirePermission('registry.write'), async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const input = ImporterInput.parse(req.body);
    const ctx = contextOf(req, 'Add importer');
    const importer = await withContext(db, ctx, async (tx) => {
      await loadClient(tx, clientId);
      return tx
        .insertInto('eu_importer')
        .values({ tenant_id: ctx.tenantId, client_id: clientId, ...toRow(input, IMPORTER_COLUMNS) } as never)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, IMPORTER_UNIQUE));
    });
    res.status(201).json({ importer: importerDto(importer) });
  });

  router.patch('/importers/:id', requirePermission('registry.write'), async (req, res) => {
    const id = idParam(req.params.id, 'importer');
    const patch = ImporterPatch.parse(req.body);
    const importer = await withContext(db, contextOf(req, 'Save importer'), async (tx) => {
      const existing = await loadImporter(tx, id);
      ImporterInput.parse({ ...fromRow(existing, IMPORTER_COLUMNS), ...patch });
      return tx
        .updateTable('eu_importer')
        .set(toRow(patch, IMPORTER_COLUMNS) as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((e) => mapDbError(e, IMPORTER_UNIQUE));
    });
    res.json({ importer: importerDto(importer) });
  });

  router.delete('/importers/:id', requirePermission('registry.write'), async (req, res) => {
    const id = idParam(req.params.id, 'importer');
    await withContext(db, contextOf(req, 'Delete importer'), async (tx) => {
      await loadImporter(tx, id);
      await tx.updateTable('eu_importer').set({ deleted_at: sql`now()` }).where('id', '=', id).execute();
    });
    res.status(204).end();
  });

  // --- team: who is assigned (M1-R2) ----------------------------------------

  router.get('/clients/:id/team', async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const team = await withContext(db, contextOf(req), async (tx) => {
      await loadClient(tx, clientId);
      const clientLevel = await tx
        .selectFrom('user_client_assignment as a')
        .innerJoin('app_user as u', 'u.id', 'a.user_id')
        .select(['u.id', 'u.display_name', 'u.email', 'u.role'])
        .where('a.client_id', '=', clientId)
        .where('u.status', '<>', 'deactivated')
        .execute();
      const installationLevel = await tx
        .selectFrom('user_installation_assignment as a')
        .innerJoin('app_user as u', 'u.id', 'a.user_id')
        .select(['u.id', 'u.display_name', 'u.email', 'u.role', 'a.installation_id'])
        .where('a.client_id', '=', clientId)
        .where('u.status', '<>', 'deactivated')
        .execute();
      return [
        ...clientLevel.map((u) => ({ ...u, installation_id: null })),
        ...installationLevel,
      ].map(
        (u): TeamMember => ({
          userId: u.id,
          displayName: u.display_name,
          email: u.email,
          role: u.role,
          installationId: u.installation_id,
        }),
      );
    });
    res.json({ team });
  });

  const loadAssignee = async (tx: Tx, userId: string) => {
    const u = await tx.selectFrom('app_user').select(['id', 'role', 'status']).where('id', '=', userId).executeTakeFirst();
    if (!u || u.status === 'deactivated') throw notFound('user');
    return u as { id: string; role: UserRole; status: string };
  };

  router.put('/clients/:id/team/:userId', requirePermission('assignments.manage'), async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const userId = idParam(req.params.userId, 'user');
    const ctx = contextOf(req, 'Assign user to client');
    await withContext(db, ctx, async (tx) => {
      await loadClient(tx, clientId);
      const user = await loadAssignee(tx, userId);
      if (user.role === 'contributor') {
        throw new AppError(400, 'assign_installation', 'Assign data contributors to installations, not to the whole client.');
      }
      await tx
        .insertInto('user_client_assignment')
        .values({ tenant_id: ctx.tenantId, user_id: userId, client_id: clientId })
        .onConflict((oc) => oc.columns(['user_id', 'client_id']).doNothing())
        .execute();
    });
    res.status(204).end();
  });

  router.delete('/clients/:id/team/:userId', requirePermission('assignments.manage'), async (req, res) => {
    const clientId = idParam(req.params.id, 'client');
    const userId = idParam(req.params.userId, 'user');
    if (userId === req.auth!.user.id) {
      throw new AppError(409, 'unassign_self', 'You cannot remove yourself from a client. Ask a platform admin.');
    }
    await withContext(db, contextOf(req, 'Remove user from client'), async (tx) => {
      await loadClient(tx, clientId);
      const r = await tx
        .deleteFrom('user_client_assignment')
        .where('client_id', '=', clientId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw notFound('assignment');
    });
    res.status(204).end();
  });

  router.put('/installations/:id/team/:userId', requirePermission('assignments.manage'), async (req, res) => {
    const installationId = idParam(req.params.id, 'installation');
    const userId = idParam(req.params.userId, 'user');
    const ctx = contextOf(req, 'Assign user to installation');
    await withContext(db, ctx, async (tx) => {
      const installation = await loadInstallation(tx, installationId);
      const user = await loadAssignee(tx, userId);
      if (user.role !== 'contributor') {
        throw new AppError(400, 'assign_client', 'Only data contributors are assigned to single installations. Assign other roles to the client.');
      }
      await tx
        .insertInto('user_installation_assignment')
        .values({ tenant_id: ctx.tenantId, client_id: installation.client_id, user_id: userId, installation_id: installationId })
        .onConflict((oc) => oc.columns(['user_id', 'installation_id']).doNothing())
        .execute();
    });
    res.status(204).end();
  });

  router.delete('/installations/:id/team/:userId', requirePermission('assignments.manage'), async (req, res) => {
    const installationId = idParam(req.params.id, 'installation');
    const userId = idParam(req.params.userId, 'user');
    await withContext(db, contextOf(req, 'Remove user from installation'), async (tx) => {
      await loadInstallation(tx, installationId);
      const r = await tx
        .deleteFrom('user_installation_assignment')
        .where('installation_id', '=', installationId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw notFound('assignment');
    });
    res.status(204).end();
  });

  // --- reference ------------------------------------------------------------

  router.get('/reference/countries', async (req, res) => {
    const countries = await withContext(db, contextOf(req), (tx) =>
      tx.selectFrom('ref_country').select(['code', 'name']).orderBy('name').execute(),
    );
    res.json({ countries: countries.map((c) => ({ code: c.code.trimEnd(), name: c.name })) });
  });

  return router;
}

import type { GoodsCategoryEntry, PeriodDetail, ProcessDetail, ProcessList } from '@cbam/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireSession } from '@/app/RequireSession';
import { mockApi, renderRoutes } from '@/test-utils';
import { ProcessListPage } from './ProcessListPage';
import { ProcessPage } from './ProcessPage';

// M5 — process builder (design system 6.4). Requirement IDs from
// .claude/skills/cbam-module-reviewer/references/modules/M05-process-goods.md

afterEach(() => vi.unstubAllGlobals());

const R1 = '4f1c2a9e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';

const me = (role: string) => ({
  status: 200,
  body: { user: { id: 'u1', tenantId: 't1', email: 'x@example.test', displayName: 'Xan', role }, mfa: 'verified' },
});

const period = (status: 'draft' | 'approved' = 'draft'): PeriodDetail => ({
  id: 'p1',
  clientId: 'c1',
  clientName: 'Aurum Metals Ltd',
  installationId: 'i1',
  installationName: 'Jamnagar smelter',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  justification: null,
  versionCount: 1,
  versions: [
    {
      id: 'v1', versionNo: 1, status, libraryVersion: { id: 'l1', code: '2026.1' }, templateVersion: { id: 't1', code: '2026-Q2' },
      basedOnVersionNo: null, approvedAt: null, issuedAt: null, createdAt: '2026-09-29T10:00:00Z',
    },
  ],
  history: [],
  datesEditable: true,
});

const cat = (over: Partial<GoodsCategoryEntry>): GoodsCategoryEntry => ({
  id: over.code!, code: '', name: '', templateName: '', sector: 'aluminium', unit: 't',
  indirectRelevantDefinitive: false, indirectRelevantTransitional: true, routeRelevant: false,
  routes: [], precursors: [], qualifyingParameters: [], ...over,
});

const library: GoodsCategoryEntry[] = [
  cat({ code: 'cement', name: 'Cement', sector: 'cement' }),
  cat({
    code: 'unwrought_aluminium', name: 'Unwrought aluminium', routeRelevant: true,
    routes: [{ code: 'primary_smelting', name: 'Primary (electrolytic) smelting' }, { code: 'secondary_melting', name: 'Secondary melting (recycling)' }],
  }),
  cat({ code: 'aluminium_products', name: 'Aluminium products', precursors: [{ routeCode: null, precursorCode: 'unwrought_aluminium' }] }),
];

const list = (over: Partial<ProcessList> = {}): ProcessList => ({
  periodVersionId: 'v1',
  libraryVersion: { id: 'l1', code: '2026.1' },
  locked: false,
  processes: [],
  checks: [],
  ...over,
});

const amount = (value: string) => ({ value, unit: 't', si: value, source: 'Production log', provenance: 'measured' as const, defaultRef: null });

const detail = (over: Partial<ProcessDetail> = {}): ProcessDetail => ({
  id: 'pr1', position: 1, name: 'Potline', goodsCategory: { code: 'unwrought_aluminium', name: 'Unwrought aluminium', unit: 't' },
  status: 'draft', activityLevel: '1000', goodsCount: 1, openChecks: { critical: 1, warning: 0 },
  periodVersionId: 'v1', installationId: 'i1', clientId: 'c1', libraryVersionId: 'l1', routeRelevant: true,
  routes: [{ id: R1, routeCode: 'primary_smelting', routeName: 'Primary (electrolytic) smelting', amount: amount('1000') }],
  includedCategories: [],
  goods: [{ id: 'g1', cnCode: '76011090', cnDescription: 'Aluminium, not alloyed, unwrought', productName: null, produced: amount('1200'), soldEu: null, soldOther: null, parameters: [] }],
  qualifyingParameters: [{ position: 2, name: 't scrap per t aluminium', required: true, valueKind: 'number', dimension: 'mass_ratio', choices: null }],
  internalUses: [],
  nonCbam: null,
  balance: { activityLevel: '1000', goods: '1200', internalUse: '0', nonCbam: '0', difference: '-200', tolerance: '0.005', withinTolerance: false },
  checks: [{ ruleId: 'M5-C05', severity: 'critical', message: 'Potline: goods, internal use and non-CBAM consumption add up to 1,200 t, but the activity level is 1,000 t.', processId: 'pr1', record: { type: 'production_process', id: 'pr1' } }],
  completedAt: null, completedBy: null, otherProcesses: [],
  ...over,
});

const summary = (d: ProcessDetail) => ({ id: d.id, position: d.position, name: d.name, goodsCategory: d.goodsCategory, status: d.status, activityLevel: d.activityLevel, goodsCount: d.goodsCount, openChecks: d.openChecks });

function render(role: string, path: string, extra: Parameters<typeof mockApi>[0] = {}, opts: { locked?: boolean; l?: ProcessList } = {}) {
  const calls = mockApi({
    'GET /auth/me': me(role),
    'GET /periods/p1': { status: 200, body: { period: period(opts.locked ? 'approved' : 'draft') } },
    'GET /period-versions/v1/processes': { status: 200, body: opts.l ?? list({ locked: !!opts.locked }) },
    'GET /library/versions/l1/goods': { status: 200, body: { goods: library } },
    'GET /processes/pr1': { status: 200, body: { process: detail() } },
    'GET /records/production_process/pr1/evidence': { status: 200, body: { evidence: [] } },
    ...extra,
  });
  const router = renderRoutes(
    [
      {
        element: <RequireSession />,
        children: [
          { path: '/periods/:periodId/processes', element: <ProcessListPage /> },
          { path: '/periods/:periodId/processes/:processId', element: <ProcessPage /> },
        ],
      },
    ],
    path,
  );
  return { calls, router };
}

describe('process list', () => {
  it('shows context, the empty state and the add action for a consultant', async () => {
    render('consultant', '/periods/p1/processes');
    expect(await screen.findByText(/No processes yet\. Add one process per aggregated goods category/)).toBeInTheDocument();
    const bar = screen.getByRole('navigation', { name: 'Current context' });
    expect(bar).toHaveTextContent('Aurum Metals Ltd');
    expect(bar).toHaveTextContent('Jamnagar smelter');
    expect(bar).toHaveTextContent('Draft');
    expect(screen.getAllByRole('button', { name: 'Add process' }).length).toBeGreaterThan(0);
  });

  it('lists processes with activity level, status and open checks; a reviewer cannot add', async () => {
    render('reviewer', '/periods/p1/processes', {}, { l: list({ processes: [summary(detail())] }) });
    const row = (await screen.findByRole('link', { name: /Potline/ })).closest('tr')!;
    expect(row).toHaveTextContent('P1');
    expect(row).toHaveTextContent('1,000 t');
    expect(row).toHaveTextContent('Draft');
    expect(row).toHaveTextContent('1 critical');
    expect(screen.getByText(/of/, { selector: 'p' })).toHaveTextContent('1 of 10 processes');
    expect(screen.queryByRole('button', { name: 'Add process' })).toBeNull();
  });

  it('shows the API error when the list cannot load', async () => {
    render('consultant', '/periods/p1/processes', {
      'GET /period-versions/v1/processes': { status: 404, body: { error: { code: 'not_found', message: 'This reporting period does not exist or you do not have access to it.' } } },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('This reporting period does not exist or you do not have access to it.');
  });

  it('M5-R1: the add dialog offers only the routes of the chosen category, and precursors to include', async () => {
    const { calls, router } = render('consultant', '/periods/p1/processes', {
      'POST /period-versions/v1/processes': { status: 201, body: { process: detail() } },
    });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add process' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    const category = within(dialog).getByLabelText('Aggregated goods category');
    await userEvent.selectOptions(category, 'cement');
    expect(within(dialog).getByText('Cement has no production routes: production is entered as one amount.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();

    await userEvent.selectOptions(category, 'aluminium_products');
    expect(within(dialog).getByRole('checkbox', { name: 'Unwrought aluminium' })).toBeInTheDocument();

    await userEvent.selectOptions(category, 'unwrought_aluminium');
    expect(within(dialog).getAllByRole('checkbox').map((c) => c.closest('label')!.textContent)).toEqual(['Primary (electrolytic) smelting', 'Secondary melting (recycling)']);
    await userEvent.type(within(dialog).getByLabelText('Process name'), 'Potline');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add process' }));
    expect(await within(dialog).findByText('Choose at least one production route.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Primary (electrolytic) smelting' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add process' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/periods/p1/processes/pr1'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Potline', goodsCategoryCode: 'unwrought_aluminium', routeCodes: ['primary_smelting'], includedCategories: [] });
  });

  it('G4: a locked period shows the banner and no add action', async () => {
    render('consultant', '/periods/p1/processes', {}, { locked: true });
    expect(await screen.findByText('This period is approved and read-only. Return it to draft to make changes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add process' })).toBeNull();
  });
});

describe('process detail', () => {
  it('shows checks with rule IDs, and the balance opens its calculation trace', async () => {
    render('consultant', '/periods/p1/processes/pr1');
    expect(await screen.findByText(/add up to 1,200 t, but the activity level is 1,000 t/)).toBeInTheDocument();
    expect(screen.getByText(/Critical · M5-C05/)).toBeInTheDocument();
    expect(screen.getByText(/Outside the tolerance of 0.5 %/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Production balance — Potline: show calculation/ }));
    const drawer = await screen.findByRole('dialog');
    expect(drawer).toHaveTextContent('Difference = AL − Σ goods − Σ internal use − non-CBAM');
    expect(drawer).toHaveTextContent('Good 76011090');
    expect(drawer).toHaveTextContent('Library 2026.1');
  });

  it('D20: marking complete with a critical check open shows the checks from the API', async () => {
    render('consultant', '/periods/p1/processes/pr1', {
      'POST /processes/pr1/complete': { status: 409, body: { error: { code: 'checks_open', message: "This process can't be marked complete: 1 critical check is open.", details: { checks: detail().checks } } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Mark process complete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This process can't be marked complete: 1 critical check is open.");
  });

  it('M5-R5: a category change lists the affected records and resends with confirmation', async () => {
    const { calls } = render('consultant', '/periods/p1/processes/pr1', {
      'PATCH /processes/pr1': (_u, init) =>
        JSON.parse(String(init?.body)).confirm
          ? { status: 200, body: { process: detail({ goodsCategory: { code: 'aluminium_products', name: 'Aluminium products', unit: 't' }, goods: [] }) } }
          : {
              status: 409,
              body: {
                error: {
                  code: 'confirm_required',
                  message: 'Changing the goods category changes 2 records that already hold data. Check the list and confirm.',
                  details: { affected: [{ table: 'process_route', id: R1, label: 'Production by Primary (electrolytic) smelting: 1,000 t' }, { table: 'process_good', id: 'g1', label: 'Good 76011090: 1,200 t produced' }] },
                },
              },
            },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit set-up' }));
    const setup = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(setup).getByLabelText('Aggregated goods category'), 'aluminium_products');
    await userEvent.click(within(setup).getByRole('button', { name: 'Save process' }));
    const confirm = await screen.findByRole('dialog', { name: 'Change the set-up of this process?' });
    const items = within(within(confirm).getByRole('list', { name: 'Records affected' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Production by Primary (electrolytic) smelting: 1,000 t', 'Good 76011090: 1,200 t produced']);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Change set-up and delete records' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { confirm: boolean }).confirm)).toEqual([false, true]));
    expect(await screen.findByText('Process saved')).toBeInTheDocument();
  });

  it('M5-R6: deleting a process with data confirms twice, then sends confirm=true', async () => {
    const { calls, router } = render('consultant', '/periods/p1/processes/pr1', {
      'DELETE /processes/pr1': { status: 409, body: { error: { code: 'confirm_required', message: 'x', details: { affected: [{ table: 'process_good', id: 'g1', label: 'Good 76011090: 1,200 t produced' }] } } } },
      'DELETE /processes/pr1?confirm=true': { status: 204 },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete process' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete process' }));
    const second = await screen.findByRole('dialog', { name: 'Delete Potline and its data?' });
    expect(second).toHaveTextContent('Good 76011090: 1,200 t produced');
    await userEvent.click(within(second).getByRole('button', { name: 'Delete process and data' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/periods/p1/processes'));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/processes/pr1', '/processes/pr1?confirm=true']);
  });

  it('M5-R2 / AT1: the API message for a CN code of another category shows on the field', async () => {
    render('consultant', '/periods/p1/processes/pr1', {
      'POST /processes/pr1/goods': {
        status: 400,
        body: { error: { code: 'validation_failed', message: 'Some fields are not valid. Fix them and try again.', issues: [{ path: ['cnCode'], message: 'CN code 25232900 is Cement, not Unwrought aluminium. Add it to a process for Cement.' }] } },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add good' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('CN code'), '2523 2900');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add good' }));
    const field = within(dialog).getByLabelText('CN code');
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(within(dialog).getByText('CN code 25232900 is Cement, not Unwrought aluminium. Add it to a process for Cement.')).toBeInTheDocument();
  });

  it('D21: a contributor enters data but sees no set-up controls', async () => {
    const { calls } = render('contributor', '/periods/p1/processes/pr1', {
      'PUT /processes/pr1/production': { status: 200, body: { process: detail() } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Save production' }));
    for (const name of ['Edit set-up', 'Delete process', 'Mark process complete', 'Add good', 'Delete good']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Enter data' })).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        routes: [{ routeId: R1, amount: { value: '1000', unit: 't', provenance: 'measured', source: 'Production log' } }],
        nonCbam: null,
        internalUses: [],
      }),
    );
  });

  it('G5: an amount needs its data source, with the message on the field', async () => {
    const { calls } = render('consultant', '/periods/p1/processes/pr1', {
      'GET /processes/pr1': { status: 200, body: { process: detail({ routes: [{ id: R1, routeCode: 'primary_smelting', routeName: 'Primary (electrolytic) smelting', amount: null }] }) } },
    });
    await userEvent.type(await screen.findByLabelText('Production by Primary (electrolytic) smelting (required)'), '950');
    await userEvent.click(screen.getByRole('button', { name: 'Save production' }));
    expect(await screen.findByText('Enter the data source.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('G4: a locked period shows values as text and no write controls', async () => {
    render('consultant', '/periods/p1/processes/pr1', {}, { locked: true });
    expect(await screen.findByText('This period is approved and read-only. Return it to draft to make changes.')).toBeInTheDocument();
    for (const name of ['Save production', 'Edit set-up', 'Delete process', 'Mark process complete', 'Enter data', 'Add good']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('textbox', { name: /Production by/ })).toBeNull();
  });
});

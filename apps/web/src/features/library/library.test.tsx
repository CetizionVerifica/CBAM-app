import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireSession } from '@/app/RequireSession';
import { mockApi, renderRoutes } from '@/test-utils';
import { LibraryPage } from './LibraryPage';
import { OverridesPanel } from './OverridesPanel';

afterEach(() => vi.unstubAllGlobals());

const me = (role: string, id = 'u1') => ({
  status: 200,
  body: { user: { id, tenantId: 't1', email: 'x@example.test', displayName: 'Xan', role }, mfa: 'verified' },
});

const published = {
  id: 'v1', code: '2026.1', status: 'published', basedOnCode: null, notes: 'From template 2026-Q2.', publishedAt: '2026-09-29T10:00:00Z',
  isCurrent: true, createdAt: '2026-09-29T10:00:00Z', counts: { factors: 2, cnCodes: 1, goodsCategories: 1 },
};
const draft = { ...published, id: 'v2', code: '2026.2', status: 'draft', basedOnCode: '2026.1', publishedAt: null, isCurrent: false, notes: null };

const factor = (over: Record<string, unknown> = {}) => ({
  id: 'f1', kind: 'emission_factor', subject: 'Natural gas', countryCode: null, region: null, year: null, component: null,
  value: '56.1', unit: 'tCO2/TJ', valueSi: '56.1', siUnit: 'tCO2/TJ', plausibleMin: '54', plausibleMax: '58.5',
  validFrom: '2026-01-01', validTo: null, source: 'Template 2026-Q2', notes: null, ...over,
});

function library(role: string, versions: object[], extra: Record<string, unknown> = {}) {
  const calls = mockApi({
    'GET /auth/me': me(role),
    'GET /library/versions': { status: 200, body: { versions } },
    'GET /library/versions/v1/factors': { status: 200, body: { factors: [factor()] } },
    'GET /library/versions/v2/factors': { status: 200, body: { factors: [factor({ id: 'f2', value: '56.4' })] } },
    'GET /reference/countries': { status: 200, body: { countries: [{ code: 'IN', name: 'India' }] } },
    ...(extra as object),
  });
  renderRoutes([{ element: <RequireSession />, children: [{ path: '/library', element: <LibraryPage /> }] }], '/library');
  return calls;
}

describe('reference library', () => {
  it('shows the current version read-only to a consultant, value with its unit', async () => {
    library('consultant', [published]);
    expect(await screen.findByText('Natural gas')).toBeInTheDocument();
    expect(screen.getByText('56.1')).toBeInTheDocument();
    expect(screen.getAllByText('tCO₂/TJ').length).toBeGreaterThan(0);
    expect(screen.getByText(/Version 2026.1 is published and read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create draft version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('switches tabs with the arrow keys', async () => {
    library('consultant', [published]);
    const tab = await screen.findByRole('tab', { name: 'Emission factors' });
    tab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'NCVs' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/Version 2026.1 has no net calorific values/)).toBeInTheDocument();
  });

  it('publishing shows the diff and needs the version code typed back', async () => {
    const calls = library('platform_admin', [draft, published], {
      'GET /library/versions/v2/diff': {
        status: 200,
        body: {
          fingerprint: 'f'.repeat(64),
          diff: {
            factors: {
              added: [],
              removed: [],
              changed: [{ key: 'k', label: 'Emission factor: Natural gas', before: { value: '56.1' }, after: { value: '56.4' }, fields: ['value'] }],
            },
          },
        },
      },
      'POST /library/versions/v2/publish': { status: 200, body: { version: { ...draft, status: 'published' } } },
    });
    await userEvent.selectOptions(await screen.findByLabelText('Version'), 'v2');
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Periods already open, approved or issued keep the version they pinned/)).toBeInTheDocument();
    expect(await within(dialog).findByText('Emission factor: Natural gas')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Publish version' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type 2026.2 to confirm'), '2026.2');
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ confirmCode: '2026.2', diffFingerprint: 'f'.repeat(64) }));
    expect(await screen.findByText('Version 2026.2 published')).toBeInTheDocument();
  });

  it('AT2 in the UI: a rejected import lists each line and its problem', async () => {
    library('platform_admin', [draft, published], {
      'POST /library/versions/v2/imports': {
        status: 400,
        body: {
          error: {
            code: 'import_rejected',
            message: 'The file was not imported: line 3 has an error. Fix it and upload the file again.',
            details: { errors: [{ row: 3, column: 'value', message: 'Enter a number, using a dot as the decimal separator.' }] },
          },
        },
      },
    });
    await userEvent.selectOptions(await screen.findByLabelText('Version'), 'v2');
    await userEvent.click(await screen.findByRole('button', { name: 'Import file' }));
    const dialog = await screen.findByRole('dialog');
    const file = new File(['kind,subject\n'], 'ncv.csv', { type: 'text/csv' });
    await userEvent.upload(within(dialog).getByLabelText('CSV file'), file);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check file' }));
    expect(await within(dialog).findByText(/line 3 has an error/)).toBeInTheDocument();
    const row = within(dialog).getByRole('row', { name: /3 value Enter a number/ });
    expect(row).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Apply to draft' })).not.toBeInTheDocument();
  });
});

const override = (over: Record<string, unknown> = {}) => ({
  id: 'o1', clientId: 'c1', kind: 'emission_factor', subject: 'Natural gas', countryCode: null, region: null, year: null, component: null,
  value: '55.8', unit: 'tCO2/TJ', valueSi: '55.8', siUnit: 'tCO2/TJ', validFrom: '2026-01-01', validTo: null,
  source: 'Lab report 118', justification: 'Measured monthly.', status: 'proposed', proposedBy: 'u1', proposedByName: 'Cara',
  proposedAt: '2026-09-29T10:00:00Z', decidedByName: null, decidedAt: null, decisionNote: null,
  libraryValue: { value: '56.1', unit: 'tCO2/TJ', versionCode: '2026.1' }, ...over,
});

function overrides(role: string, list: object[], extra: Record<string, unknown> = {}) {
  const calls = mockApi({
    'GET /auth/me': me(role),
    'GET /clients/c1/factor-overrides': { status: 200, body: { overrides: list } },
    'GET /reference/countries': { status: 200, body: { countries: [{ code: 'IN', name: 'India' }] } },
    ...(extra as object),
  });
  renderRoutes([{ element: <RequireSession />, children: [{ path: '/c', element: <OverridesPanel clientId="c1" /> }] }], '/c');
  return calls;
}

describe('client factor overrides (M4-R5)', () => {
  it('flags the override and shows the library value beside it; a consultant cannot approve', async () => {
    overrides('consultant', [override()]);
    expect(await screen.findByLabelText('Client override')).toBeInTheDocument();
    expect(screen.getByText('55.8')).toBeInTheDocument();
    expect(screen.getByText('56.1')).toBeInTheDocument();
    expect(screen.getByText('library 2026.1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('a consultant proposes an override with the shared schema’s rules', async () => {
    const calls = overrides('consultant', [], {
      'POST /clients/c1/factor-overrides': { status: 201, body: { override: override() } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Propose override' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Applies to/), 'Natural gas');
    await userEvent.type(within(dialog).getByLabelText(/^Value/), '55.8');
    await userEvent.type(within(dialog).getByLabelText(/^Valid from/), '2026-01-01');
    await userEvent.type(within(dialog).getByLabelText(/^Source/), 'Lab report 118');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Propose override' }));
    expect(await within(dialog).findByText('Say why this client needs its own value.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/^Justification/), 'Measured monthly.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Propose override' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        kind: 'emission_factor', subject: 'Natural gas', value: '55.8', unit: 'tCO2/TJ', year: null, countryCode: null, justification: 'Measured monthly.',
      }),
    );
  });

  it('the admin approves with an optional note', async () => {
    const calls = overrides('platform_admin', [override({ proposedBy: 'someone-else' })], {
      'POST /factor-overrides/o1/approve': { status: 200, body: { override: override({ status: 'approved' }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Checked.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve override' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ note: 'Checked.' }));
    expect(await screen.findByText('Override approved')).toBeInTheDocument();
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireSession } from '@/app/RequireSession';
import { PortfolioPage } from '@/features/portfolio/PortfolioPage';
import { mockApi, renderRoutes } from '@/test-utils';
import { InstallationPage } from './InstallationPages';

afterEach(() => vi.unstubAllGlobals());

const me = (role: string) => ({
  status: 200,
  body: { user: { id: 'u1', tenantId: 't1', email: 'x@example.test', displayName: 'Xan', role }, mfa: 'verified' },
});

const installation = {
  id: 'i1', clientId: 'c1', nameEn: 'Jamnagar smelter', nameLocal: null, street: 'Plot 4', economicActivity: null,
  postcode: null, poBox: null, city: 'Jamnagar', countryCode: 'IN', unLocode: 'INJGA', latitude: '22.470000',
  longitude: '70.057700', authRepName: null, authRepEmail: null, authRepPhone: null, permitNo: null, updatedAt: '',
};

function installationRoutes(role: string) {
  const calls = mockApi({
    'GET /auth/me': me(role),
    'GET /installations/i1': { status: 200, body: { installation } },
    'GET /clients/c1': { status: 200, body: { client: { id: 'c1', legalName: 'Aurum Metals Ltd', countryCode: 'IN', city: 'Mumbai' }, installations: [installation], importers: [] } },
    'GET /reference/countries': { status: 200, body: { countries: [{ code: 'IN', name: 'India' }, { code: 'TR', name: 'Türkiye' }] } },
    'PATCH /installations/i1': (_url, init) => ({ status: 200, body: { installation: { ...installation, ...JSON.parse(String(init?.body)) } } }),
  });
  renderRoutes([{ element: <RequireSession />, children: [{ path: '/installations/:installationId', element: <InstallationPage /> }] }], '/installations/i1');
  return calls;
}

const patches = (calls: { method: string; body: unknown }[]) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

describe('installation profile', () => {
  it('shows client › installation in the context bar', async () => {
    installationRoutes('consultant');
    const bar = await screen.findByRole('navigation', { name: 'Current context' });
    await waitFor(() => expect(bar).toHaveTextContent('Aurum Metals Ltd'));
    expect(bar).toHaveTextContent('Jamnagar smelter');
  });

  it('autosaves only the field that changed, on blur', async () => {
    const calls = installationRoutes('consultant');
    const city = await screen.findByLabelText(/^City/);
    await userEvent.clear(city);
    await userEvent.type(city, 'Jamnagar Rural');
    fireEvent.blur(city);
    await waitFor(() => expect(patches(calls)).toEqual([{ city: 'Jamnagar Rural' }]));
    expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
  });

  it('AT2 in the form: latitude 95 is refused before anything is sent', async () => {
    const calls = installationRoutes('consultant');
    const lat = await screen.findByLabelText(/^Latitude/);
    await userEvent.clear(lat);
    await userEvent.type(lat, '95');
    fireEvent.blur(lat);
    expect(await screen.findByText('Latitude must be between −90 and 90.')).toBeInTheDocument();
    expect(patches(calls)).toEqual([]);
  });

  it('checks the UN/LOCODE against a changed country before saving', async () => {
    const calls = installationRoutes('consultant');
    const country = await screen.findByLabelText(/^Country/);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Türkiye' })).toBeInTheDocument());
    await userEvent.selectOptions(country, 'TR');
    fireEvent.blur(country);
    expect(await screen.findByText('The UN/LOCODE must start with the installation’s country code.')).toBeInTheDocument();
    expect(patches(calls)).toEqual([]);

    // Fixing the second field saves both changes together.
    const locode = screen.getByLabelText(/^UN\/LOCODE/);
    await userEvent.clear(locode);
    await userEvent.type(locode, 'TRIZM');
    fireEvent.blur(locode);
    await waitFor(() => expect(patches(calls)).toEqual([{ countryCode: 'TR', unLocode: 'TRIZM' }]));
  });

  it('is read-only for a reviewer: no edits, no delete', async () => {
    installationRoutes('reviewer');
    const city = await screen.findByLabelText(/^City/);
    expect(city).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Delete installation' })).not.toBeInTheDocument();
  });
});

describe('portfolio', () => {
  it('offers the first client to a consultant when empty', async () => {
    mockApi({ 'GET /auth/me': me('consultant'), 'GET /clients': { status: 200, body: { clients: [] } }, 'GET /reference/countries': { status: 200, body: { countries: [] } } });
    renderRoutes([{ element: <RequireSession />, children: [{ path: '/', element: <PortfolioPage /> }] }], '/');
    expect(await screen.findByText('No clients yet. Add the first operator you report for.')).toBeInTheDocument();
  });

  it('lists clients with the template country name', async () => {
    mockApi({
      'GET /auth/me': me('reviewer'),
      'GET /clients': { status: 200, body: { clients: [{ id: 'c1', legalName: 'Aurum Metals Ltd', countryCode: 'TR', city: 'Izmir', installationCount: 2 }] } },
      'GET /reference/countries': { status: 200, body: { countries: [{ code: 'TR', name: 'Türkiye' }] } },
    });
    renderRoutes([{ element: <RequireSession />, children: [{ path: '/', element: <PortfolioPage /> }] }], '/');
    expect(await screen.findByRole('link', { name: 'Aurum Metals Ltd' })).toBeInTheDocument();
    expect(await screen.findByText('Türkiye')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add client' })).not.toBeInTheDocument();
  });
});

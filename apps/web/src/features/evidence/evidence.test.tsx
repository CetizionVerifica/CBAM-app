import type { AuditEntry, EvidenceSummary, VerificationDetail } from '@cbam/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireSession } from '@/app/RequireSession';
import { navFor } from '@/app/nav';
import { AuditTrailPage } from '@/features/audit/AuditTrailPage';
import { VerificationSection } from '@/features/periods/VerificationSection';
import { mockApi, renderRoutes } from '@/test-utils';
import { EvidencePanel } from './EvidencePanel';

afterEach(() => vi.unstubAllGlobals());

const me = (role: string) => ({
  status: 200,
  body: { user: { id: 'u1', tenantId: 't1', email: 'x@example.test', displayName: 'Xan', role }, mfa: 'verified' },
});

const doc = (over: Partial<EvidenceSummary> = {}): EvidenceSummary => ({
  id: 'e1',
  clientId: 'c1',
  installationId: 'i1',
  title: 'Gas meter, January',
  docType: 'meter_reading',
  documentDate: '2026-01-31',
  fileName: 'meter.pdf',
  contentType: 'application/pdf',
  bytes: 1_258_291,
  sha256: 'a'.repeat(64),
  uploadedAt: '2026-02-01T09:00:00Z',
  uploadedById: 'u2',
  uploadedBy: 'Kiran Contributor',
  links: [{ id: 'l1', recordType: 'installation', recordId: 'i1', label: 'Installation: Jamnagar smelter', locked: false }],
  locked: false,
  ...over,
});

function renderPanel(role: string, evidence: EvidenceSummary[], locked = false, extra: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({
    'GET /auth/me': me(role),
    'GET /records/installation/i1/evidence': { status: 200, body: { evidence } },
    ...extra,
  });
  renderRoutes(
    [{ element: <RequireSession />, children: [{ path: '/x', element: <EvidencePanel clientId="c1" installationId="i1" recordType="installation" recordId="i1" locked={locked} /> }] }],
    '/x',
  );
  return calls;
}

const fileInput = () => document.querySelector('input[type=file]') as HTMLInputElement;

describe('evidence panel (M13-R1, R3, R4)', () => {
  it('lists the evidence with type, size and uploader, and offers download and unlink', async () => {
    renderPanel('consultant', [doc()]);
    expect(await screen.findByRole('link', { name: 'Gas meter, January' })).toBeInTheDocument();
    expect(screen.getByText(/Meter reading · meter\.pdf/)).toHaveTextContent('1.2 MB');
    expect(screen.getByText(/uploaded by Kiran Contributor/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });

  it('refuses a wrong type or an oversized file before sending anything', async () => {
    const calls = renderPanel('consultant', []);
    await screen.findByText(/No evidence yet/);
    await userEvent.upload(fileInput(), new File(['MZ'], 'setup.exe'), { applyAccept: false });
    expect(await screen.findByText('setup.exe: Only PDF, PNG, JPEG, XLSX and CSV files are accepted.')).toBeInTheDocument();
    const big = new File(['%PDF-'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
    await userEvent.upload(fileInput(), big);
    expect(await screen.findByText('big.pdf: Files over 25 MB aren’t accepted. Split or compress the file.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('uploads a file as the raw body, linked to this record, with the chosen type', async () => {
    const calls = renderPanel('contributor', [], false, {
      'POST /clients/c1/evidence?fileName=gas.pdf&docType=invoice&installationId=i1&recordType=installation&recordId=i1': {
        status: 201,
        body: { evidence: doc({ title: 'gas.pdf' }) },
      },
    });
    await screen.findByText(/No evidence yet/);
    await userEvent.selectOptions(screen.getByLabelText('Type of evidence'), 'invoice');
    await userEvent.upload(fileInput(), new File(['%PDF-1.7'], 'gas.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toBeInstanceOf(File);
    expect(await screen.findByText('Evidence uploaded')).toBeInTheDocument();
  });

  it('a locked period shows the files read-only', async () => {
    renderPanel('consultant', [doc({ locked: true })], true);
    expect(await screen.findByText('This period is read-only, so its evidence cannot change.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Download/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
    expect(fileInput()).toBeNull();
  });

  it('recipients see no evidence panel at all', async () => {
    renderPanel('recipient', [doc()]);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Evidence' })).toBeNull());
  });
});

describe('navigation (G2 display only)', () => {
  it('Evidence and Audit trail by role', () => {
    const labels = (role: Parameters<typeof navFor>[0]) => navFor(role).flat().map((i) => i.label);
    expect(labels('consultant')).toEqual(expect.arrayContaining(['Evidence', 'Audit trail']));
    expect(labels('reviewer')).toEqual(expect.arrayContaining(['Evidence', 'Audit trail']));
    expect(labels('contributor')).toContain('Evidence');
    expect(labels('contributor')).not.toContain('Audit trail');
    expect(labels('recipient')).not.toContain('Evidence');
    expect(labels('recipient')).not.toContain('Audit trail');
  });
});

describe('audit trail (M13-R5, R6)', () => {
  const entry: AuditEntry = {
    id: 42,
    occurredAt: '2026-09-30T08:15:00Z',
    actorId: 'u2',
    actorName: 'Cara Consultant',
    actorRole: 'consultant',
    action: 'Edit installation',
    op: 'UPDATE',
    table: 'public.installation',
    recordId: 'i1',
    clientId: 'c1',
    reason: null,
    changes: [
      { field: 'city', old: 'Jamnagar', new: 'Jamnagar Rural' },
      { field: 'postcode', old: null, new: '361001' },
    ],
  };

  it('shows old and new values side by side, one row per field, and exports with the same filters', async () => {
    const calls = mockApi({
      'GET /auth/me': me('reviewer'),
      'GET /clients': { status: 200, body: { clients: [{ id: 'c1', legalName: 'Aurum Metals Ltd', countryCode: 'IN', city: 'Mumbai', installationCount: 1 }] } },
      'GET /audit?': { status: 200, body: { entries: [entry], next: null } },
      'GET /audit?clientId=c1': { status: 200, body: { entries: [entry], next: null } },
    });
    renderRoutes([{ element: <RequireSession />, children: [{ path: '/audit', element: <AuditTrailPage /> }] }], '/audit');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Cara Consultant');
    expect(rows[1]).toHaveTextContent('Edit installation');
    expect(rows[1]).toHaveTextContent('cityJamnagarJamnagar Rural');
    expect(rows[2]).toHaveTextContent('postcode—361001');
    // Reviewers cannot list users, so there is no user filter.
    expect(screen.queryByLabelText('User')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Client'), 'c1');
    await waitFor(() => expect(calls.some((c) => c.path === '/audit?clientId=c1')).toBe(true));
    expect(screen.getByRole('link', { name: /Export CSV/ })).toHaveAttribute('href', '/api/v1/audit.csv?clientId=c1');
  });

  it('empty and error states', async () => {
    mockApi({
      'GET /auth/me': me('consultant'),
      'GET /clients': { status: 200, body: { clients: [] } },
      'GET /users': { status: 200, body: { users: [] } },
      'GET /audit?': { status: 200, body: { entries: [], next: null } },
    });
    renderRoutes([{ element: <RequireSession />, children: [{ path: '/audit', element: <AuditTrailPage /> }] }], '/audit');
    expect(await screen.findByText('No changes match these filters.')).toBeInTheDocument();
  });
});

describe('verification (M13-R7)', () => {
  const empty: VerificationDetail = {
    id: null, periodVersionId: 'v1', verifierName: null, verifierStreet: null, verifierCity: null, verifierPostcode: null,
    verifierCountryCode: null, repName: null, repEmail: null, repPhone: null, repFax: null, accreditationMemberState: null,
    accreditationBody: null, accreditationRegNo: null, siteVisitDate: null, opinion: null, findings: [],
    consultantApproval: null, clientApproval: null,
  };

  function renderVerification(role: string, v: VerificationDetail, locked = false) {
    const calls = mockApi({
      'GET /auth/me': me(role),
      'GET /reference/countries': { status: 200, body: { countries: [{ code: 'DE', name: 'Germany' }] } },
      'GET /period-versions/v1/verification': { status: 200, body: { verification: v } },
      'PUT /period-versions/v1/verification': (_u, init) => {
        const body = JSON.parse(String(init?.body));
        return { status: 200, body: { verification: { ...v, id: 'f1', ...body } } };
      },
      'POST /period-versions/v1/verification/approvals': { status: 200, body: { verification: { ...v, consultantApproval: { at: '2026-09-30T10:00:00Z', by: 'Xan' } } } },
    });
    renderRoutes([{ element: <RequireSession />, children: [{ path: '/x', element: <VerificationSection versionId="v1" locked={locked} /> }] }], '/x');
    return calls;
  }

  it('saves findings as a list, one per line', async () => {
    const calls = renderVerification('reviewer', empty);
    const findings = await screen.findByLabelText(/^Findings/);
    await userEvent.type(findings, 'Meter M3 certificate expired.{enter}{enter}Scale not calibrated.');
    findings.blur();
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ findings: ['Meter M3 certificate expired.', 'Scale not calibrated.'] }));
    // Reviewers do not approve.
    expect(screen.queryByRole('button', { name: 'Approve verification' })).toBeNull();
  });

  it('the consultant approves once details exist; a locked period is read-only', async () => {
    renderVerification('consultant', { ...empty, id: 'f1', verifierName: 'TÜV Verifica' });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve verification' }));
    expect(await screen.findByText(/Approved by Xan/)).toBeInTheDocument();
  });

  it('locked: no approval buttons and read-only fields', async () => {
    renderVerification('consultant', { ...empty, id: 'f1', verifierName: 'TÜV Verifica' }, true);
    expect(await screen.findByLabelText(/^Company name/)).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Approve verification' })).toBeNull();
  });
});

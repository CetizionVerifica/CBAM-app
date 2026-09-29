import type { PeriodDetail, PeriodVersionSummary } from '@cbam/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireSession } from '@/app/RequireSession';
import { mockApi, renderRoutes } from '@/test-utils';
import { PeriodPage } from './PeriodPage';
import { PeriodsPanel } from './PeriodsPanel';

afterEach(() => vi.unstubAllGlobals());

const me = (role: string) => ({
  status: 200,
  body: { user: { id: 'u1', tenantId: 't1', email: 'x@example.test', displayName: 'Xan', role }, mfa: 'verified' },
});

const version = (over: Partial<PeriodVersionSummary> = {}): PeriodVersionSummary => ({
  id: 'v1',
  versionNo: 1,
  status: 'draft',
  libraryVersion: { id: 'l1', code: '2026.1' },
  templateVersion: { id: 't1', code: '2026-Q2' },
  basedOnVersionNo: null,
  approvedAt: null,
  issuedAt: null,
  createdAt: '2026-09-29T10:00:00Z',
  ...over,
});

const period = (over: Partial<PeriodDetail> = {}): PeriodDetail => ({
  id: 'p1',
  clientId: 'c1',
  clientName: 'Aurum Metals Ltd',
  installationId: 'i1',
  installationName: 'Jamnagar smelter',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  justification: null,
  versionCount: 1,
  versions: [version()],
  history: [{ id: 'h1', versionNo: 1, fromStatus: null, toStatus: 'draft', reason: null, changedAt: '2026-09-29T10:00:00Z', changedBy: 'Cara Consultant' }],
  datesEditable: true,
  ...over,
});

function renderPeriod(role: string, p: PeriodDetail, extra: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({ 'GET /auth/me': me(role), 'GET /periods/p1': { status: 200, body: { period: p } }, ...extra });
  renderRoutes([{ element: <RequireSession />, children: [{ path: '/periods/:periodId', element: <PeriodPage /> }] }], '/periods/p1');
  return calls;
}

describe('periods panel on the installation profile', () => {
  function renderPanel(role: string) {
    const calls = mockApi({
      'GET /auth/me': me(role),
      'GET /installations/i1/periods': { status: 200, body: { periods: [] } },
      'POST /installations/i1/periods': (_u, init) => ({
        status: 201,
        body: { period: period({ ...JSON.parse(String(init?.body)) }) },
      }),
      'GET /periods/p1': { status: 200, body: { period: period() } },
    });
    const router = renderRoutes(
      [{ element: <RequireSession />, children: [{ path: '/installations/i1', element: <PeriodsPanel installationId="i1" /> }, { path: '/periods/:id', element: <p>period page</p> }] }],
      '/installations/i1',
    );
    return { calls, router };
  }

  it('empty state offers to open a period; the end date follows the start; other than a calendar year needs a reason', async () => {
    const { calls, router } = renderPanel('consultant');
    await userEvent.click(await screen.findByRole('button', { name: 'Open reporting period' }));
    const dialog = await screen.findByRole('dialog');
    const start = within(dialog).getByLabelText('Start date');
    await userEvent.clear(start);
    await userEvent.type(start, '2026-04-01');
    expect(within(dialog).getByText(/31 Mar 2027|Mar 31, 2027/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open reporting period' }));
    expect(await within(dialog).findByText('Say why this period does not follow the calendar year.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);

    await userEvent.type(within(dialog).getByLabelText('Why not the calendar year?'), 'Financial year April to March');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open reporting period' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/periods/p1'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      justification: 'Financial year April to March',
    });
  });

  it('a reviewer sees no open action', async () => {
    renderPanel('reviewer');
    expect(await screen.findByText('No reporting periods yet. A consultant opens them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open reporting period' })).toBeNull();
  });
});

describe('period overview', () => {
  it('shows client › installation › period and status in the context bar', async () => {
    renderPeriod('consultant', period());
    const bar = await screen.findByRole('navigation', { name: 'Current context' });
    expect(bar).toHaveTextContent('Aurum Metals Ltd');
    expect(bar).toHaveTextContent('Jamnagar smelter');
    expect(bar).toHaveTextContent('2026');
    expect(bar).toHaveTextContent('Draft');
    expect(screen.getByRole('heading', { name: '2026 reporting period' })).toBeInTheDocument();
    expect(screen.getByText('2026.1')).toBeInTheDocument();
  });

  it('a consultant submits a draft for review in one click', async () => {
    const calls = renderPeriod('consultant', period(), {
      'POST /period-versions/v1/transitions': { status: 200, body: { period: period({ versions: [version({ status: 'in_review' })] }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ action: 'submit' }));
    expect(await screen.findByText('Submitted for review')).toBeInTheDocument();
  });

  it('returning to draft asks for a reason and sends it', async () => {
    const approved = period({ versions: [version({ status: 'approved', approvedAt: '2026-09-29T11:00:00Z' })], datesEditable: false });
    const calls = renderPeriod('consultant', approved, {
      'POST /period-versions/v1/transitions': { status: 200, body: { period: period() } },
    });
    expect(await screen.findByText('This period is approved and read-only. Return it to draft to make changes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit period dates' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Return to draft' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Return to draft' }));
    expect(await within(dialog).findByText('Say why this period goes back to draft.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Gas meter reading was wrong');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Return to draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ action: 'reopen', reason: 'Gas meter reading was wrong' }));
  });

  it('approving asks for confirmation and states the consequence', async () => {
    renderPeriod('reviewer', period({ versions: [version({ status: 'in_review' })], datesEditable: false }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve period' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Approving locks all data in this period.');
    expect(screen.queryByRole('button', { name: 'Return to draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Clone/ })).toBeNull();
  });

  it('an issued version is locked and offers a new version', async () => {
    const issued = period({
      versions: [version({ status: 'issued', approvedAt: '2026-09-29T11:00:00Z', issuedAt: '2026-09-29T12:00:00Z' })],
      datesEditable: false,
    });
    const calls = renderPeriod('consultant', issued, {
      'POST /periods/p1/versions': {
        status: 201,
        body: { period: period({ versions: [version({ id: 'v2', versionNo: 2, basedOnVersionNo: 1 }), issued.versions[0]!], versionCount: 2, datesEditable: false }) },
      },
    });
    expect(await screen.findByText('Version 1 is issued and read-only. Create a new version to make changes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create new version' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/periods/p1/versions')).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Versions' })).toBeInTheDocument();
    expect(screen.getByText('2026 reporting period', { selector: 'h1' })).toBeInTheDocument();
  });

  it('an API refusal is shown in plain words', async () => {
    renderPeriod('consultant', period(), {
      'POST /period-versions/v1/transitions': { status: 409, body: { error: { code: 'invalid_transition', message: "This period is in review, so you can't submit for review now." } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText("This period is in review, so you can't submit for review now.")).toBeInTheDocument();
  });

  it('a period the user cannot see shows the error, not a blank page', async () => {
    mockApi({ 'GET /auth/me': me('consultant') });
    renderRoutes([{ element: <RequireSession />, children: [{ path: '/periods/:periodId', element: <PeriodPage /> }] }], '/periods/p1');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

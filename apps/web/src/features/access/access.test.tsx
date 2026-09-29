import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireSession } from '@/app/RequireSession';
import { UsersPage } from '@/features/settings/UsersPage';
import { mockApi, renderRoutes } from '@/test-utils';
import { SignInPage } from './SignInPage';

afterEach(() => vi.unstubAllGlobals());

const consultant = {
  user: { id: 'u1', tenantId: 't1', email: 'c@example.test', displayName: 'Cara Consultant', role: 'consultant' },
  mfa: 'verified',
};

describe('sign-in', () => {
  it('validates on the client with the shared schema messages', async () => {
    mockApi({});
    renderRoutes([{ path: '/sign-in', element: <SignInPage /> }], '/sign-in');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
  });

  it('shows the API message and sends a consultant without 2FA to set-up', async () => {
    mockApi({
      'POST /auth/login': { status: 200, body: { ...consultant, mfa: 'setup_required' } },
    });
    const router = renderRoutes(
      [
        { path: '/sign-in', element: <SignInPage /> },
        { path: '/two-factor/setup', element: <p>setup</p> },
      ],
      '/sign-in',
    );
    await userEvent.type(screen.getByLabelText('Email'), 'c@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a long password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/two-factor/setup'));
  });

  it('shows the wrong-credentials message from the API', async () => {
    mockApi({
      'POST /auth/login': { status: 401, body: { error: { code: 'bad_credentials', message: 'The email or password is not correct.' } } },
    });
    renderRoutes([{ path: '/sign-in', element: <SignInPage /> }], '/sign-in');
    await userEvent.type(screen.getByLabelText('Email'), 'c@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not correct.');
  });
});

describe('RequireSession', () => {
  it('sends a signed-out visitor to sign-in, keeping where they were going', async () => {
    mockApi({ 'GET /auth/me': { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in' } } } });
    const router = renderRoutes(
      [
        { path: '/sign-in', element: <p>sign in</p> },
        { element: <RequireSession />, children: [{ path: '/settings/users', element: <p>users</p> }] },
      ],
      '/settings/users',
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toBe('?next=%2Fsettings%2Fusers');
  });

  it('sends a session that still needs its code to the 2FA challenge', async () => {
    mockApi({ 'GET /auth/me': { status: 200, body: { ...consultant, mfa: 'required' } } });
    const router = renderRoutes(
      [
        { path: '/sign-in/verify', element: <p>verify</p> },
        { element: <RequireSession />, children: [{ path: '/', element: <p>home</p> }] },
      ],
      '/',
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in/verify'));
  });
});

describe('users screen', () => {
  it('lets a consultant invite only client-side roles and hides admin actions', async () => {
    mockApi({
      'GET /auth/me': { status: 200, body: consultant },
      'GET /users': {
        status: 200,
        body: {
          users: [
            { id: 'u1', email: 'c@example.test', displayName: 'Cara Consultant', role: 'consultant', status: 'active', twoFactorEnabled: true, createdAt: '' },
            { id: 'u2', email: 'p@example.test', displayName: 'Pat Plant', role: 'contributor', status: 'active', twoFactorEnabled: false, createdAt: '' },
          ],
        },
      },
    });
    renderRoutes([{ element: <RequireSession />, children: [{ path: '/', element: <UsersPage /> }] }], '/');
    expect(await screen.findByText('Pat Plant')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Pat Plant' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Invite user' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Data contributor', 'Reviewer / verifier', 'Report recipient']);
  });
});

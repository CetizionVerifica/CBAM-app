import { createBrowserRouter } from 'react-router';
import { AcceptInvitationPage } from '@/features/access/AcceptInvitationPage';
import { SignInPage } from '@/features/access/SignInPage';
import { TwoFactorSetupPage } from '@/features/access/TwoFactorSetupPage';
import { VerifyPage } from '@/features/access/VerifyPage';
import { PortfolioPage } from '@/features/portfolio/PortfolioPage';
import { UsersPage } from '@/features/settings/UsersPage';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';
import { RequireSession } from './RequireSession';

export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/sign-in/verify', element: <VerifyPage /> },
  { path: '/two-factor/setup', element: <TwoFactorSetupPage /> },
  { path: '/invitation/:token', element: <AcceptInvitationPage /> },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/', element: <PortfolioPage /> },
          { path: '/settings/users', element: <UsersPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

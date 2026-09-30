import { createBrowserRouter } from 'react-router';
import { AcceptInvitationPage } from '@/features/access/AcceptInvitationPage';
import { SignInPage } from '@/features/access/SignInPage';
import { TwoFactorSetupPage } from '@/features/access/TwoFactorSetupPage';
import { VerifyPage } from '@/features/access/VerifyPage';
import { PortfolioPage } from '@/features/portfolio/PortfolioPage';
import { ClientPage } from '@/features/registry/ClientPage';
import { InstallationPage, NewInstallationPage } from '@/features/registry/InstallationPages';
import { NewClientPage } from '@/features/registry/NewClientPage';
import { LibraryPage } from '@/features/library/LibraryPage';
import { PeriodPage } from '@/features/periods/PeriodPage';
import { EvidenceLibraryPage } from '@/features/evidence/EvidenceLibraryPage';
import { AuditTrailPage } from '@/features/audit/AuditTrailPage';
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
          { path: '/clients/new', element: <NewClientPage /> },
          { path: '/clients/:clientId', element: <ClientPage /> },
          { path: '/clients/:clientId/installations/new', element: <NewInstallationPage /> },
          { path: '/installations/:installationId', element: <InstallationPage /> },
          { path: '/periods/:periodId', element: <PeriodPage /> },
          { path: '/evidence', element: <EvidenceLibraryPage /> },
          { path: '/audit', element: <AuditTrailPage /> },
          { path: '/library', element: <LibraryPage /> },
          { path: '/settings/users', element: <UsersPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

import { createBrowserRouter } from 'react-router';
import { PortfolioPage } from '@/features/portfolio/PortfolioPage';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <PortfolioPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

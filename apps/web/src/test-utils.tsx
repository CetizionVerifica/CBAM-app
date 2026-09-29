import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { type RouteObject, RouterProvider, createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { ToastProvider } from './components/Toast';

type Reply = { status: number; body?: unknown };
type Handler = (url: string, init?: RequestInit) => Reply | Promise<Reply>;

/** Replaces fetch with a handler keyed on "METHOD /path". */
export function mockApi(routes: Record<string, Handler | { status: number; body?: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace('/api/v1', '');
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    const r = typeof route === 'function' ? await route(input, init) : (route ?? { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status });
  });
  return calls;
}

export function renderRoutes(routes: RouteObject[], path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

import type { MeResponse } from '@cbam/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';

export const ME_KEY = ['auth', 'me'] as const;

/** The signed-in user and their 2FA state; null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<MeResponse>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useSetMe() {
  const qc = useQueryClient();
  return (me: MeResponse | null) => qc.setQueryData(ME_KEY, me);
}

/** Where a session should go next, from its 2FA state. */
export function nextStepFor(me: MeResponse, next = '/'): string {
  switch (me.mfa) {
    case 'required':
      return `/sign-in/verify?next=${encodeURIComponent(next)}`;
    case 'setup_required':
      return `/two-factor/setup?next=${encodeURIComponent(next)}`;
    default:
      return next;
  }
}

/** Only same-app paths are allowed as redirect targets. */
export const safeNext = (raw: string | null): string => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/');

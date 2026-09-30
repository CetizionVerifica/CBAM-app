import type { AffectedRecord, GoodsCategoryEntry, ProcessDetail, ProcessList } from '@cbam/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';

export const processKeys = {
  all: ['processes'] as const,
  ofVersion: (versionId: string) => ['processes', 'version', versionId] as const,
  process: (id: string) => ['processes', id] as const,
};

export const useProcessList = (versionId: string) =>
  useQuery({
    queryKey: processKeys.ofVersion(versionId),
    queryFn: () => api.get<ProcessList>(`/period-versions/${versionId}/processes`),
    enabled: !!versionId,
    retry: false,
  });

export const useProcess = (id: string) =>
  useQuery({
    queryKey: processKeys.process(id),
    queryFn: async () => (await api.get<{ process: ProcessDetail }>(`/processes/${id}`)).process,
    retry: false,
  });

/** Relevant precursors of a category, directly or through other precursors (D16), as the API checks. */
export function precursorsOf(library: GoodsCategoryEntry[], main: string): Set<string> {
  const byCode = new Map(library.map((c) => [c.code, c]));
  const seen = new Set<string>();
  const stack = [main];
  while (stack.length) {
    for (const p of byCode.get(stack.pop()!)?.precursors ?? []) {
      if (!seen.has(p.precursorCode)) {
        seen.add(p.precursorCode);
        stack.push(p.precursorCode);
      }
    }
  }
  seen.delete(main);
  return seen;
}

/** The records a change would delete, when the API asks for confirmation (M5-R5, R6; D22). */
export const affectedOf = (e: unknown): AffectedRecord[] | null =>
  e instanceof ApiError && e.code === 'confirm_required' ? ((e.details as { affected?: AffectedRecord[] })?.affected ?? []) : null;

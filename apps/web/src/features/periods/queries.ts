import type { PeriodDetail, PeriodSummary } from '@cbam/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const periodKeys = {
  ofInstallation: (installationId: string) => ['installations', installationId, 'periods'] as const,
  period: (id: string) => ['periods', id] as const,
};

export const useInstallationPeriods = (installationId: string) =>
  useQuery({
    queryKey: periodKeys.ofInstallation(installationId),
    queryFn: async () => (await api.get<{ periods: PeriodSummary[] }>(`/installations/${installationId}/periods`)).periods,
  });

export const usePeriod = (id: string) =>
  useQuery({
    queryKey: periodKeys.period(id),
    queryFn: async () => (await api.get<{ period: PeriodDetail }>(`/periods/${id}`)).period,
    retry: false,
  });

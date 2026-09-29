import type { ClientDetail, ClientSummary, ImporterDetail, InstallationDetail, TeamMember } from '@cbam/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const keys = {
  clients: ['clients'] as const,
  client: (id: string) => ['clients', id] as const,
  team: (id: string) => ['clients', id, 'team'] as const,
  installation: (id: string) => ['installations', id] as const,
};

export interface ClientBundle {
  client: ClientDetail;
  installations: InstallationDetail[];
  importers: ImporterDetail[];
}

export const useClients = () =>
  useQuery({ queryKey: keys.clients, queryFn: async () => (await api.get<{ clients: ClientSummary[] }>('/clients')).clients });

export const useClient = (id: string) =>
  useQuery({ queryKey: keys.client(id), queryFn: () => api.get<ClientBundle>(`/clients/${id}`), retry: false });

export const useTeam = (clientId: string) =>
  useQuery({ queryKey: keys.team(clientId), queryFn: async () => (await api.get<{ team: TeamMember[] }>(`/clients/${clientId}/team`)).team });

export const useInstallation = (id: string) =>
  useQuery({
    queryKey: keys.installation(id),
    queryFn: async () => (await api.get<{ installation: InstallationDetail }>(`/installations/${id}`)).installation,
    retry: false,
  });

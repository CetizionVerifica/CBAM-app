import type { EvidenceRecordType, EvidenceSummary } from '@cbam/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const evidenceKeys = {
  all: ['evidence'] as const,
  ofClient: (clientId: string) => ['evidence', 'client', clientId] as const,
  ofRecord: (type: EvidenceRecordType, id: string) => ['evidence', 'record', type, id] as const,
};

export const useClientEvidence = (clientId: string) =>
  useQuery({
    queryKey: evidenceKeys.ofClient(clientId),
    queryFn: async () => (await api.get<{ evidence: EvidenceSummary[] }>(`/clients/${clientId}/evidence`)).evidence,
    enabled: !!clientId,
  });

export const useRecordEvidence = (type: EvidenceRecordType, id: string) =>
  useQuery({
    queryKey: evidenceKeys.ofRecord(type, id),
    queryFn: async () => (await api.get<{ evidence: EvidenceSummary[] }>(`/records/${type}/${id}/evidence`)).evidence,
  });

/** Asks for a 5-minute signed link and starts the download (M13-R2). */
export async function downloadEvidence(id: string) {
  const { url } = await api.get<{ url: string }>(`/evidence/${id}/download`);
  window.location.assign(url);
}

/** "1.2 MB" — file sizes, with the unit next to the number. */
export function formatBytes(bytes: number, locale: string = navigator.language): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

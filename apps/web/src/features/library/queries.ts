import type {
  CnCodeEntry,
  FactorKind,
  FactorOverride,
  GoodsCategoryEntry,
  LibraryDiff,
  LibraryFactor,
  LibrarySettings,
  LibraryVersionSummary,
  TemplateVersionEntry,
} from '@cbam/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const libraryKeys = {
  versions: ['library', 'versions'] as const,
  version: (id: string) => ['library', 'versions', id] as const,
  factors: (id: string) => ['library', 'versions', id, 'factors'] as const,
  cnCodes: (id: string) => ['library', 'versions', id, 'cn-codes'] as const,
  goods: (id: string) => ['library', 'versions', id, 'goods'] as const,
  diff: (id: string) => ['library', 'versions', id, 'diff'] as const,
  settings: (id: string) => ['library', 'versions', id, 'settings'] as const,
  templates: ['library', 'templates'] as const,
  overrides: (clientId: string) => ['clients', clientId, 'factor-overrides'] as const,
};

export const useLibraryVersions = () =>
  useQuery({
    queryKey: libraryKeys.versions,
    // canEdit: platform admin of the operator tenant (decision D12), decided by the API.
    queryFn: () => api.get<{ versions: LibraryVersionSummary[]; canEdit: boolean }>('/library/versions'),
  });

export const useFactors = (versionId: string) =>
  useQuery({
    queryKey: libraryKeys.factors(versionId),
    queryFn: async () => (await api.get<{ factors: LibraryFactor[] }>(`/library/versions/${versionId}/factors`)).factors,
    enabled: !!versionId,
  });

export const useCnCodes = (versionId: string) =>
  useQuery({
    queryKey: libraryKeys.cnCodes(versionId),
    queryFn: async () => (await api.get<{ cnCodes: CnCodeEntry[] }>(`/library/versions/${versionId}/cn-codes`)).cnCodes,
    enabled: !!versionId,
  });

export const useGoods = (versionId: string) =>
  useQuery({
    queryKey: libraryKeys.goods(versionId),
    queryFn: async () => (await api.get<{ goods: GoodsCategoryEntry[] }>(`/library/versions/${versionId}/goods`)).goods,
    enabled: !!versionId,
  });

/** Versioned settings such as the production balance tolerance (D19). */
export const useLibrarySettings = (versionId: string) =>
  useQuery({
    queryKey: libraryKeys.settings(versionId),
    queryFn: async () => (await api.get<{ settings: LibrarySettings }>(`/library/versions/${versionId}/settings`)).settings,
    enabled: !!versionId,
  });

export const useVersionDiff = (versionId: string, enabled: boolean) =>
  useQuery({
    queryKey: libraryKeys.diff(versionId),
    queryFn: () => api.get<{ diff: LibraryDiff; fingerprint: string }>(`/library/versions/${versionId}/diff`),
    enabled,
  });

export const useTemplates = () =>
  useQuery({
    queryKey: libraryKeys.templates,
    queryFn: async () => (await api.get<{ templates: TemplateVersionEntry[] }>('/library/templates')).templates,
  });

export const useOverrides = (clientId: string) =>
  useQuery({
    queryKey: libraryKeys.overrides(clientId),
    queryFn: async () => (await api.get<{ overrides: FactorOverride[] }>(`/clients/${clientId}/factor-overrides`)).overrides,
  });

/** Library tabs (design system 6.12). */
export const FACTOR_TABS: { kind: FactorKind; label: string; empty: string }[] = [
  { kind: 'emission_factor', label: 'Emission factors', empty: 'emission factors' },
  { kind: 'ncv', label: 'NCVs', empty: 'net calorific values' },
  { kind: 'grid_factor', label: 'Grid factors', empty: 'grid emission factors' },
  { kind: 'gwp', label: 'GWPs', empty: 'global warming potentials' },
  { kind: 'default_see', label: 'Default values', empty: 'default values' },
];

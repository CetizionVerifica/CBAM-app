import type { Country } from '@cbam/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Template country list (codes + template names); changes only with a template version. */
export function useCountries() {
  return useQuery({
    queryKey: ['reference', 'countries'],
    queryFn: async () => (await api.get<{ countries: Country[] }>('/reference/countries')).countries,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useCountryName() {
  const countries = useCountries();
  return (code: string | null | undefined) =>
    (code && countries.data?.find((c) => c.code === code)?.name) ?? code ?? '';
}

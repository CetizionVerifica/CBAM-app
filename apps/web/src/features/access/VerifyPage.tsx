import { type MeResponse, RecoveryCode, TotpCode } from '@cbam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { ErrorState } from '@/components/States';
import { ApiError, api } from '@/lib/api';
import { safeNext, useSetMe } from '@/lib/session';

/** Two-factor challenge after sign-in (M1-R5). */
export function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setMe = useSetMe();
  const [useRecovery, setUseRecovery] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const schema = z.object({ value: useRecovery ? RecoveryCode : TotpCode });
  const form = useForm<{ value: string }>({ resolver: zodResolver(schema), defaultValues: { value: '' } });

  const onSubmit = form.handleSubmit(async ({ value }) => {
    setFormError(null);
    try {
      const me = await api.post<MeResponse>('/auth/mfa/verify', useRecovery ? { recoveryCode: value } : { code: value });
      setMe(me);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'account_locked') {
        setMe(null);
        navigate('/sign-in?reason=locked', { replace: true });
        return;
      }
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      form.reset({ value: '' });
    }
  });

  return (
    <AuthLayout
      title="Two-factor authentication"
      description={useRecovery ? 'Enter one of your saved recovery codes. Each code works once.' : 'Enter the 6-digit code from your authenticator app.'}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError && <ErrorState message={formError} />}
        <Field
          key={String(useRecovery)}
          label={useRecovery ? 'Recovery code' : 'Code'}
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoFocus
          error={form.formState.errors.value?.message}
          {...form.register('value')}
        />
        <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
          Verify
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setFormError(null);
            form.reset({ value: '' });
          }}
        >
          {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}
        </Button>
      </form>
    </AuthLayout>
  );
}

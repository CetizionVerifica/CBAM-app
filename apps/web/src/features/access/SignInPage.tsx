import { zodResolver } from '@hookform/resolvers/zod';
import { LoginRequest, type MeResponse } from '@cbam/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { ErrorState } from '@/components/States';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/forms';
import { nextStepFor, safeNext, useSetMe } from '@/lib/session';

type Values = z.input<typeof LoginRequest>;

export function SignInPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setMe = useSetMe();
  // Why the user was sent here (review M1 F9); the API gave the same words.
  const [formError, setFormError] = useState<string | null>(
    params.get('reason') === 'locked' ? 'Too many failed attempts. Try again in 15 minutes.' : null,
  );
  const form = useForm<Values>({
    resolver: zodResolver(LoginRequest),
    mode: 'onBlur',
    defaultValues: { email: params.get('email') ?? '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const me = await api.post<MeResponse>('/auth/login', values);
      setMe(me);
      navigate(nextStepFor(me, safeNext(params.get('next'))), { replace: true });
    } catch (e) {
      setFormError(applyServerError(e, form.setError));
    }
  });

  return (
    <AuthLayout title="Sign in">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError && <ErrorState message={formError} />}
        <Field label="Email" type="email" autoComplete="username" autoFocus error={form.formState.errors.email?.message} {...form.register('email')} />
        <Field label="Password" type="password" autoComplete="current-password" error={form.formState.errors.password?.message} {...form.register('password')} />
        <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  );
}

import { AcceptInvitationRequest, Password, ROLE_LABELS, type UserRole } from '@cbam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { z } from 'zod';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { ErrorState, SkeletonRows } from '@/components/States';
import { ApiError, api } from '@/lib/api';
import { applyServerError } from '@/lib/forms';

interface Invitation {
  email: string;
  displayName: string;
  role: UserRole;
  organisation: string;
  expiresAt: string;
}

const Schema = AcceptInvitationRequest.omit({ token: true })
  .extend({ confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'The passwords do not match.', path: ['confirm'] });
type Values = z.input<typeof Schema>;

/** M1-R4: set a password from a single-use invitation link. */
export function AcceptInvitationPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.get<Invitation>(`/auth/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });

  const form = useForm<Values>({ resolver: zodResolver(Schema), mode: 'onBlur', values: { displayName: invitation.data?.displayName ?? '', password: '', confirm: '' } });

  const onSubmit = form.handleSubmit(async ({ displayName, password }) => {
    setFormError(null);
    try {
      await api.post('/auth/invitations/accept', { token, displayName, password });
      navigate(`/sign-in?email=${encodeURIComponent(invitation.data!.email)}`, { replace: true });
    } catch (e) {
      setFormError(applyServerError(e, form.setError));
    }
  });

  if (invitation.isPending) {
    return (
      <AuthLayout title="Accept invitation">
        <SkeletonRows rows={4} />
      </AuthLayout>
    );
  }
  if (invitation.isError) {
    return (
      <AuthLayout title="Accept invitation">
        <ErrorState message={invitation.error instanceof ApiError ? invitation.error.message : "Couldn't load this invitation."} />
      </AuthLayout>
    );
  }

  const inv = invitation.data;
  return (
    <AuthLayout
      title="Accept invitation"
      description={`${inv.organisation} invited ${inv.email} as ${ROLE_LABELS[inv.role].toLowerCase()}. Set a password to finish.`}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError && <ErrorState message={formError} />}
        <Field label="Your name" autoComplete="name" error={form.formState.errors.displayName?.message} {...form.register('displayName')} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${Password.minLength} characters. A short sentence works well.`}
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <Field label="Repeat password" type="password" autoComplete="new-password" error={form.formState.errors.confirm?.message} {...form.register('confirm')} />
        <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
          Set password
        </Button>
      </form>
    </AuthLayout>
  );
}

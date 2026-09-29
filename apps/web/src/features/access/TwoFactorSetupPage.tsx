import { MfaEnableRequest, type MeResponse } from '@cbam/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router';
import { AuthLayout } from '@/components/AuthLayout';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { ErrorState, SkeletonRows } from '@/components/States';
import { ApiError, api } from '@/lib/api';
import { safeNext, useMe, useSetMe } from '@/lib/session';

/** Mandatory for admins and consultants on first sign-in (M1-R5). */
export function TwoFactorSetupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const setMe = useSetMe();
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const setup = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup'),
    onSuccess: async (d) => setQr(await QRCode.toString(d.otpauthUrl, { type: 'svg', margin: 0 })),
  });
  // Once per mount: a second set-up call would replace the secret behind the QR code
  // (React StrictMode runs effects twice in development; review M1 F8).
  const started = useRef(false);
  const start = setup.mutate;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start();
  }, [start]);

  const form = useForm<{ code: string }>({ resolver: zodResolver(MfaEnableRequest), defaultValues: { code: '' } });
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', values);
      setCodes(r.recoveryCodes);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  });

  const finish = () => {
    if (me.data) setMe({ ...me.data, mfa: 'verified' } satisfies MeResponse);
    navigate(safeNext(params.get('next')), { replace: true });
  };

  if (codes) {
    return (
      <AuthLayout title="Save your recovery codes" description="If you lose your phone, each code lets you sign in once. Store them somewhere safe; they won't be shown again.">
        <ul className="mb-6 grid grid-cols-2 gap-2 rounded-input bg-surface-sunken p-4 font-mono text-body">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>
            Copy codes
          </Button>
          <Button variant="primary" onClick={finish}>
            I've saved them — continue
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set up two-factor authentication" description="Your role requires a code from an authenticator app at every sign-in.">
      {setup.isError && (
        <ErrorState
          message={setup.error instanceof ApiError ? setup.error.message : "Couldn't start set-up."}
          actions={<Button onClick={() => setup.mutate()}>Try again</Button>}
        />
      )}
      {setup.isPending && <SkeletonRows rows={4} />}
      {setup.data && (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-body text-ink">
            <li>Scan this code with your authenticator app.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          {qr && (
            // White quiet zone so the code scans in dark mode too.
            <div className="self-start rounded-input bg-[white] p-3" role="img" aria-label="QR code for your authenticator app">
              <div className="size-40" dangerouslySetInnerHTML={{ __html: qr }} />
            </div>
          )}
          <p className="text-small text-ink-muted">
            Can't scan? Enter this key: <code className="font-mono text-ink">{setup.data.secret}</code>
          </p>
          {formError && <ErrorState message={formError} />}
          <Field label="Code" inputMode="numeric" autoComplete="one-time-code" error={form.formState.errors.code?.message} {...form.register('code')} />
          <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
            Turn on two-factor authentication
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

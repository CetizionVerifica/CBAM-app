import { Navigate, Outlet, useLocation } from 'react-router';
import { Button } from '@/components/Button';
import { ErrorState, SkeletonRows } from '@/components/States';
import { nextStepFor, useMe } from '@/lib/session';

/**
 * Routes inside the app need a session with 2FA done. This is navigation only: the API
 * enforces access on every request (G2).
 */
export function RequireSession() {
  const me = useMe();
  const location = useLocation();
  const here = location.pathname + location.search;

  if (me.isPending) {
    return (
      <div className="p-6">
        <SkeletonRows />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="p-6">
        <ErrorState message={me.error.message} actions={<Button onClick={() => void me.refetch()}>Try again</Button>} />
      </div>
    );
  }
  if (!me.data) return <Navigate to={`/sign-in?next=${encodeURIComponent(here)}`} replace />;
  const step = nextStepFor(me.data, here);
  if (step !== here) return <Navigate to={step} replace />;
  return <Outlet />;
}

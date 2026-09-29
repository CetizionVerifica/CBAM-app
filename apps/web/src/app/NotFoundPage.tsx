import { Link } from 'react-router';
import { ErrorState } from '@/components/States';

export function NotFoundPage() {
  return (
    <div className="p-6">
      <ErrorState
        message="This page does not exist. Check the address, or go back to the portfolio."
        actions={<Link className="text-body font-semibold text-action underline" to="/">Open portfolio</Link>}
      />
    </div>
  );
}

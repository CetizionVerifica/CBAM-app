import { NavLink, Outlet } from 'react-router';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/session';
import { navFor } from './nav';
import { UserMenu } from './UserMenu';

// Design system 4: 56 px top bar, 240 px side nav, fluid content.
export function AppShell() {
  const me = useMe();
  const groups = me.data ? navFor(me.data.user.role) : [];
  return (
    <div className="grid min-h-screen grid-cols-[var(--nav-width)_1fr] grid-rows-[56px_1fr] bg-canvas max-[1439px]:grid-cols-[var(--nav-width-collapsed)_1fr]">
      <header className="col-span-2 flex items-center gap-4 border-b border-rule bg-surface px-4">
        <span className="text-h3 font-semibold text-ink">CBAM reporting</span>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </header>

      <nav aria-label="Main" className="border-r border-rule bg-surface py-4">
        {groups.map((group, gi) => (
          <ul key={gi} className="mb-4 flex flex-col gap-0.5 px-2">
            {group.map(({ label, to, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end
                  title={label}
                  className={({ isActive }) =>
                    cn(
                      'flex h-9 items-center gap-3 rounded-button px-3 text-body text-ink hover:bg-surface-sunken',
                      isActive && 'bg-action-tint font-semibold',
                    )
                  }
                >
                  <Icon aria-hidden className="size-5 shrink-0" strokeWidth={1.5} />
                  <span className="max-[1439px]:sr-only">{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        ))}
      </nav>

      <main className="min-w-0 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}

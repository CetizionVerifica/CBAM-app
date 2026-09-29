import { ROLE_LABELS } from '@cbam/shared';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, LogOut, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';
import { currentTheme, setTheme } from '@/lib/theme';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

const item = 'flex h-9 cursor-default items-center gap-2 rounded-input px-2 text-body text-ink outline-none data-[highlighted]:bg-surface-sunken';

export function UserMenu() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [theme, setThemeState] = useState(currentTheme);
  if (!me.data) return null;
  const { user } = me.data;

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    navigate('/sign-in', { replace: true });
  };

  return (
    <DM.Root>
      <DM.Trigger className="flex items-center gap-2 rounded-button px-2 py-1 text-body text-ink hover:bg-surface-sunken">
        <span aria-hidden className="grid size-7 place-items-center rounded-full bg-action-tint text-caption font-semibold">
          {initials(user.displayName)}
        </span>
        <span className="max-[1023px]:sr-only">{user.displayName}</span>
        <ChevronDown aria-hidden className="size-4 text-ink-muted" strokeWidth={1.5} />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={4} className="z-50 min-w-56 rounded-panel border border-rule bg-surface p-1 shadow-float">
          <div className="px-2 py-2">
            <p className="text-body font-semibold text-ink">{user.displayName}</p>
            <p className="text-small text-ink-muted">{user.email}</p>
            <p className="text-caption text-ink-muted">{ROLE_LABELS[user.role]}</p>
          </div>
          <DM.Separator className="my-1 h-px bg-rule" />
          <DM.Item
            className={item}
            onSelect={() => {
              const next = theme === 'dark' ? 'light' : 'dark';
              setTheme(next);
              setThemeState(next);
            }}
          >
            {theme === 'dark' ? <Sun aria-hidden className="size-4" strokeWidth={1.5} /> : <Moon aria-hidden className="size-4" strokeWidth={1.5} />}
            {theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
          </DM.Item>
          <DM.Item className={item} onSelect={() => void signOut()}>
            <LogOut aria-hidden className="size-4" strokeWidth={1.5} />
            Sign out
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

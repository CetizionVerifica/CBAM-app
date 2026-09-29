import { type VariantProps, cva } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

// Design system 5.1. Labels say what happens: "Save source stream", not "Submit".
const button = cva(
  'inline-flex h-9 items-center justify-center gap-2 rounded-button px-4 text-body font-semibold transition-colors duration-[var(--duration-press)] disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-action text-surface hover:bg-action-hover',
        secondary: 'border border-rule-strong bg-surface text-ink hover:bg-surface-sunken',
        quiet: 'px-2 text-action hover:bg-action-tint',
        destructive: 'px-2 text-critical hover:bg-critical-tint',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

export function Button({ className, variant, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant }), className)} {...props} />;
}

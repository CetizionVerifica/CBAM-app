import * as RD from '@radix-ui/react-dialog';
import { Sigma, X } from 'lucide-react';
import type { ReactNode } from 'react';

export interface TraceInput {
  label: string;
  value: ReactNode;
  source?: string;
}

export interface Trace {
  title: string;
  result: ReactNode;
  formula: string;
  inputs: TraceInput[];
  /** Versions the value depends on (G8), e.g. "Library 2026.1". */
  footer?: string;
}

/** A calculated value that opens its trace (design system 5.5): the number itself is the button. */
export function TraceButton({ trace, onOpen, children }: { trace: Trace; onOpen: (t: Trace) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(trace)}
      aria-label={`${trace.title}: show calculation`}
      className="inline-flex items-center gap-1 rounded-input text-right hover:bg-action-tint"
    >
      {children}
      <Sigma aria-hidden className="size-3.5 text-ink-muted" strokeWidth={1.5} />
    </button>
  );
}

/** Calculation trace drawer (design system 5.5): right side, 480 px, formula, inputs, result. */
export function TraceDrawer({ trace, onClose }: { trace: Trace | null; onClose: () => void }) {
  return (
    <RD.Root open={trace !== null} onOpenChange={(o) => !o && onClose()}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 bg-ink/20" />
        <RD.Content className="fixed top-0 right-0 flex h-full w-[min(var(--trace-drawer-width),100vw)] flex-col gap-6 overflow-y-auto border-l border-rule bg-surface p-6 shadow-float">
          {trace && (
            <>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <RD.Title className="text-h3 font-semibold text-ink">{trace.title}</RD.Title>
                  <RD.Description className="mt-1 text-h2 font-semibold tabular-nums text-ink">{trace.result}</RD.Description>
                </div>
                <RD.Close aria-label="Close" className="rounded-button p-1 text-ink-muted hover:bg-surface-sunken">
                  <X aria-hidden className="size-4" strokeWidth={1.5} />
                </RD.Close>
              </div>
              <section>
                <h3 className="mb-2 text-body font-semibold text-ink">Formula</h3>
                <p className="rounded-input bg-surface-sunken px-3 py-2 font-mono text-small text-ink">{trace.formula}</p>
              </section>
              <section>
                <h3 className="mb-2 text-body font-semibold text-ink">Inputs</h3>
                <table className="w-full text-left text-small">
                  <thead className="text-ink-muted">
                    <tr>
                      <th scope="col" className="pb-1 font-semibold">Input</th>
                      <th scope="col" className="pb-1 text-right font-semibold">Value</th>
                      <th scope="col" className="pb-1 pl-3 font-semibold">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trace.inputs.map((i) => (
                      <tr key={i.label} className="border-t border-rule align-top">
                        <td className="py-1.5 text-ink">{i.label}</td>
                        <td className="py-1.5 text-right tabular-nums whitespace-nowrap text-ink">{i.value}</td>
                        <td className="py-1.5 pl-3 text-ink-muted">{i.source ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="border-t border-rule pt-3">
                <p className="flex justify-between text-body font-semibold text-ink">
                  <span>Result</span>
                  <span className="tabular-nums">{trace.result}</span>
                </p>
                {trace.footer && <p className="mt-1 text-caption text-ink-muted">{trace.footer}</p>}
              </section>
            </>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

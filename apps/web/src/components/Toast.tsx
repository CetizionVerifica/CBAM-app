import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';

// Design system 5.8: bottom-right, 4 s, past-tense verb matching the button ("User invited").
const ToastContext = createContext<(message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMessage(m);
    window.setTimeout(() => setMessage((cur) => (cur === m ? null : cur)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-6 bottom-6 z-50">
        {message && (
          <div className="pointer-events-auto rounded-panel border border-rule bg-surface px-4 py-3 text-body text-ink shadow-float">
            {message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

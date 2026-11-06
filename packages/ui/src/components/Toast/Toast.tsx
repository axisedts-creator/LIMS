import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../Icon/Icon';
import { IconButton } from '../IconButton/IconButton';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import { msg, type Tone } from '../_shared/messages';

export interface ToastInput {
  tone: Tone;
  title: string;
  description?: string;
  /** Default 5000; tone 'danger' persists until dismissed. */
  durationMs?: number;
}

interface ToastApi {
  show(t: ToastInput): void;
}

const ToastContext = createContext<ToastApi | null>(null);

// ponytail: no queue limit; add a max-visible cap if features start bursting toasts.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<(ToastInput & { id: number })[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts, { ...t, id }]);
      const persistent = t.tone === 'danger' || t.tone === 'critical';
      if (!persistent) timers.current.set(id, setTimeout(() => dismiss(id), t.durationMs ?? 5000));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach(clearTimeout);
  }, []);

  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="lims-toast-region">
        {toasts.map((t) => {
          const urgent = t.tone === 'danger' || t.tone === 'critical';
          return (
            <div key={t.id} role={urgent ? 'alert' : 'status'} className={`lims-toast lims-tone-${t.tone}`} data-tone={t.tone}>
              <Icon name={t.tone === 'success' ? 'check' : t.tone === 'neutral' ? 'info' : t.tone} />
              <div className="lims-toast-text">
                <VisuallyHidden>{msg.toneText[t.tone]}: </VisuallyHidden>
                <p className="lims-toast-title">{t.title}</p>
                {t.description ? <p className="lims-toast-desc">{t.description}</p> : null}
              </div>
              <IconButton label={msg.dismiss} icon="close" onPress={() => dismiss(t.id)} />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

'use client';
// Platform console client building blocks: labelled native fields (inline errors as role=alert), the single-flight guard,
// Idempotency-Key generation and the §3 reload / step-up dialogs.
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { MFA_COPY, RELOAD_COPY, errorText, type Fail } from './shared';

export function newKey(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

/** Runs one async job at a time (double clicks send once). */
export function useSingleFlight() {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const run = useCallback(async (job: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try { await job(); } finally { busy.current = false; setPending(false); }
  }, []);
  return { run, pending };
}

/** Maps a failed action to the §3 dialogs; returns the inline message for every other failure. */
export function useProblemDialogs() {
  const router = useRouter();
  const [open, setOpen] = useState<'reload' | 'mfa' | null>(null);
  const handle = useCallback((f: Fail): string | undefined => {
    if (f.code === 'common.version_conflict') { setOpen('reload'); return undefined; }
    if (f.code === 'auth.mfa_required') { setOpen('mfa'); return undefined; }
    return errorText(f);
  }, []);
  const dialogs = (
    <>
      <Dialog title="Changed by someone else" isOpen={open === 'reload'} onClose={() => setOpen(null)} size="sm"
        footer={<Button variant="primary" onPress={() => { setOpen(null); router.refresh(); }}>Reload</Button>}>
        <p>{RELOAD_COPY}</p>
      </Dialog>
      <Dialog title="Two-step verification needed" isOpen={open === 'mfa'} onClose={() => setOpen(null)} size="sm"
        footer={<Button variant="primary" onPress={() => router.push('/auth/login')}>Log in again</Button>}>
        <p>{MFA_COPY}</p>
      </Dialog>
    </>
  );
  return { handle, dialogs };
}

export function Alert({ children }: { children: ReactNode }) {
  return children ? <p role="alert" className="lims-error">{children}</p> : null;
}

interface Base { label: string; error?: string | undefined; hint?: string; disabled?: boolean; required?: boolean }

export function TextInput({ label, value, onChange, maxLength, error, hint, disabled, required, type = 'text', readOnly, onKeyDown, min, max }: Base & {
  value: string; onChange: (v: string) => void; maxLength?: number; type?: 'text' | 'email' | 'date' | 'number'; readOnly?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void; min?: number; max?: number;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      <input id={id} className="lims-input" type={type} value={value} onChange={(e) => onChange(e.target.value)}
        {...(maxLength !== undefined ? { maxLength } : {})} {...(min !== undefined ? { min } : {})} {...(max !== undefined ? { max } : {})}
        {...(readOnly ? { readOnly: true } : {})} {...(disabled ? { disabled: true } : {})} {...(onKeyDown ? { onKeyDown } : {})}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {hint ? <p id={`${id}-h`} className="lims-description">{hint}</p> : null}
      {error ? <p id={`${id}-e`} role="alert" className="lims-error">{error}</p> : null}
    </div>
  );
}

export function TextAreaInput({ label, value, onChange, maxLength, error, hint, required }: Base & { value: string; onChange: (v: string) => void; maxLength: number }) {
  const id = useId();
  const describedBy = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      <textarea id={id} className="lims-input" rows={3} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {hint ? <p id={`${id}-h`} className="lims-description">{hint}</p> : null}
      {error ? <p id={`${id}-e`} role="alert" className="lims-error">{error}</p> : null}
    </div>
  );
}

export function SelectInput({ label, value, onChange, options, error, disabled, placeholder }: Base & {
  value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}</label>
      <select id={id} className="lims-input" value={value} onChange={(e) => onChange(e.target.value)} {...(disabled ? { disabled: true } : {})}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error ? <p id={`${id}-e`} role="alert" className="lims-error">{error}</p> : null}
    </div>
  );
}

export function CheckboxInput({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="lims-field lims-field-inline">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label className="lims-label" htmlFor={id}>{label}</label>
    </div>
  );
}

export const fmtDateTime = (iso: string | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

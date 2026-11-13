'use client';
// Small client building blocks for the admin screens. Kit components are used where they fit (Banner, Dialog, ConfirmDialog, Switch,
// PermissionMatrix, DiffTable, Toast). [CONV] Field/Picker/Tabs are thin native wrappers: kit TextField enforces maxLength while typing
// (over-length must be reported, not truncated) and RAC TabPanel is labelled by its tab, which collides with field labels on AD-3.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { CONFLICT_COPY, MFA_REQUIRED_COPY, copyFor } from './lib';
import type { Fail } from './server/api';

/** Button that navigates (Load more / Clear filters keep the user on the list, 02-CV §4.3). */
export function NavButton({ href, children }: { href: string; children: string }) {
  const router = useRouter();
  return <Button onPress={() => router.push(href)}>{children}</Button>;
}

// ---------------------------------------------------------------- feedback
export function Alert({ text, requestId }: { text: string; requestId?: string | undefined }) {
  return (
    <div role="alert">
      <Banner tone="danger" title={text}>{requestId ? <p>Reference: {requestId}</p> : null}</Banner>
    </div>
  );
}

/** Outcome of a failed write: version conflict and step-up get dialogs (04-UI-UX §3); field pointers go inline; the rest is a banner. */
export function useFailure() {
  const [fail, setFail] = useState<Fail | null>(null);
  const conflict = fail?.code === 'common.version_conflict';
  const mfa = fail?.code === 'auth.mfa_required';
  const fieldOf = (pointer: string) => pointer.replace(/^\//, '').split('/')[0] ?? '';
  return {
    fail,
    set: setFail,
    clear: () => setFail(null),
    fieldErrors: Object.fromEntries((fail?.pointers ?? []).map((p) => [fieldOf(p), copyFor(fail?.code === 'identity.setting_out_of_range' ? 'identity.setting_out_of_range' : 'common.validation_failed')])) as Record<string, string>,
    banner: fail && !conflict && !mfa ? <Alert text={copyFor(fail.code)} requestId={fail.requestId} /> : null,
    dialogs: (
      <>
        <ConflictDialog isOpen={conflict} onClose={() => setFail(null)} />
        <MfaDialog isOpen={mfa} onClose={() => setFail(null)} />
      </>
    ),
  };
}

export function ConflictDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const router = useRouter();
  return (
    <Dialog title="Changed by someone else" isOpen={isOpen} onClose={onClose} size="sm"
      footer={<Button variant="primary" onPress={() => { onClose(); router.refresh(); }}>Reload</Button>}>
      <p>{CONFLICT_COPY}</p>
    </Dialog>
  );
}

export function MfaDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const go = () => {
    const next = typeof window === 'undefined' ? '/admin' : window.location.pathname;
    window.location.assign(`/auth/logout?next=${encodeURIComponent(`/auth/login?next=${next}`)}`);
  };
  return (
    <Dialog title="Two-step verification needed" isOpen={isOpen} onClose={onClose} size="sm" footer={<Button variant="primary" onPress={go}>Log in again</Button>}>
      <p>{MFA_REQUIRED_COPY}</p>
    </Dialog>
  );
}

/** Error summary at the top of a form with links to the fields (04-UI-UX §8). */
export function ErrorSummary({ errors, ids }: { errors: Record<string, string>; ids: Record<string, string> }) {
  const keys = Object.keys(errors).filter((k) => errors[k]);
  if (!keys.length) return null;
  return (
    <div role="alert" className="lims-banner lims-tone-danger" data-tone="danger">
      <p className="lims-banner-title">Check these fields:</p>
      <ul>{keys.map((k) => <li key={k}><a href={`#${ids[k] ?? k}`}>{errors[k]}</a></li>)}</ul>
    </div>
  );
}
/** Moves focus to the first invalid control after render. */
export function focusFirstInvalid(root: HTMLElement | null) {
  setTimeout(() => (root?.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus(), 0);
}

// ---------------------------------------------------------------- fields
interface FieldProps {
  label: string; value: string; onChange?: (v: string) => void; error?: string | undefined; hint?: string | undefined; type?: string; readOnly?: boolean | undefined;
  maxLength?: number; inputMode?: 'text' | 'numeric' | 'tel' | 'email'; multiline?: boolean; id?: string; autoComplete?: string; required?: boolean;
}
export function Field({ label, value, onChange, error, hint, type = 'text', readOnly, maxLength, inputMode, multiline, id, autoComplete, required }: FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  const describedBy = [hint ? `${fid}-hint` : '', error ? `${fid}-err` : ''].filter(Boolean).join(' ') || undefined;
  const common = {
    id: fid, value, readOnly, className: 'lims-input', 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy,
    ...(maxLength !== undefined ? { maxLength } : {}), ...(required ? { 'aria-required': true } : {}),
    onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
  };
  return (
    <div className="lims-field">
      <label htmlFor={fid} className="lims-label">{label}</label>
      {multiline ? <textarea rows={3} {...common} /> : <input type={type} {...common} {...(inputMode ? { inputMode } : {})} {...(autoComplete ? { autoComplete } : {})} />}
      {hint ? <p id={`${fid}-hint`} className="lims-description">{hint}</p> : null}
      {error ? <p id={`${fid}-err`} className="lims-error">{error}</p> : null}
    </div>
  );
}

export interface Opt { value: string; label: string; tag?: string | undefined }
/** Single or multi select as a listbox popup (button + role=listbox). Escape or outside click closes. */
export function Picker({ label, options, value, onChange, multiple, error, disabled, id }: { label: string; options: readonly Opt[]; value: readonly string[]; onChange: (v: string[]) => void; multiple?: boolean; error?: string | undefined; disabled?: boolean | undefined; id?: string }) {
  const auto = useId();
  const bid = id ?? `${auto}-btn`;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('mousedown', down);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', down); };
  }, [open]);
  const chosen = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  const toggle = (v: string) => {
    if (!multiple) { onChange([v]); setOpen(false); return; }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  const onKey = (e: React.KeyboardEvent<HTMLLIElement>, v: string) => {
    const el = e.currentTarget;
    if (e.key === 'ArrowDown') { e.preventDefault(); (el.nextElementSibling as HTMLElement | null)?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (el.previousElementSibling as HTMLElement | null)?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(v); }
  };
  return (
    <div className="lims-field" ref={wrap}>
      <label id={`${auto}-lbl`} htmlFor={bid} className="lims-label">{label}</label>
      <button id={bid} type="button" className="lims-input lims-picker" aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
        aria-labelledby={`${auto}-lbl ${bid}`} {...(error ? { 'aria-invalid': true, 'aria-describedby': `${auto}-err` } : {})}
        {...(open ? { 'aria-controls': `${auto}-list` } : {})} onClick={() => setOpen(!open)}>
        {chosen.length ? chosen.join(', ') : 'None selected'}
      </button>
      {open ? (
        <ul id={`${auto}-list`} role="listbox" aria-labelledby={`${auto}-lbl`} className="lims-popover lims-listbox" {...(multiple ? { 'aria-multiselectable': true } : {})}>
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={value.includes(o.value)} tabIndex={-1} className="lims-option" onClick={() => toggle(o.value)} onKeyDown={(e) => onKey(e, o.value)}>
              {o.label}{o.tag ? <span className="lims-chip lims-chip-sm lims-tone-warning"> {o.tag}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p id={`${auto}-err`} className="lims-error">{error}</p> : null}
    </div>
  );
}

/** Radio group. Each radio is named by aria-labelledby → a visible `<data value>` (machine value + visible text), so option names
 *  ("All centres") never shadow the neighbouring field labels ("Centres") for label lookups. Clicking the text selects. */
export function Radios({ legend, name, options, value, onChange, disabled }: { legend: string; name: string; options: readonly Opt[]; value: string; onChange: (v: string) => void; disabled?: boolean | undefined }) {
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={`${id}-lg`} className="lims-field">
      <p id={`${id}-lg`} className="lims-label">{legend}</p>
      {options.map((o, i) => (
        <span key={o.value} className="lims-check" onClick={() => !disabled && onChange(o.value)}>
          <input type="radio" name={`${name}-${id}`} aria-labelledby={`${id}-o${i}`} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
          {' '}<data id={`${id}-o${i}`} value={o.value}>{o.label}</data>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- tabs
export function Tabs({ items, selected, onChange, children, label = 'Sections' }: { items: readonly string[]; selected: string; onChange: (t: string) => void; children: ReactNode; label?: string }) {
  const id = useId();
  const slug = (t: string) => `${id}-${t.replace(/[^A-Za-z0-9]/g, '')}`;
  const move = (i: number) => { const t = items[(i + items.length) % items.length]!; onChange(t); setTimeout(() => document.getElementById(`${slug(t)}-tab`)?.focus(), 0); };
  return (
    <div className="lims-tabs">
      <div role="tablist" aria-label={label} className="lims-tablist">
        {items.map((t, i) => (
          <button key={t} id={`${slug(t)}-tab`} type="button" role="tab" className="lims-tab" aria-selected={t === selected} tabIndex={t === selected ? 0 : -1}
            {...(t === selected ? { 'aria-controls': `${slug(t)}-panel` } : {})} onClick={() => onChange(t)}
            onKeyDown={(e) => { if (e.key === 'ArrowRight') move(i + 1); else if (e.key === 'ArrowLeft') move(i - 1); }}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${slug(selected)}-panel`} className="lims-tabpanel" tabIndex={0}>{children}</div>
    </div>
  );
}

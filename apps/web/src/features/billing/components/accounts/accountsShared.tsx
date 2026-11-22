'use client';
// T0D-ACCT-1 (LD-313) shared bits for the lab accounting screens: permission-gated buttons with a visible reason, the select used where the
// selected value must not become part of the field name, paisa parsing, CSV export, label lookups. Text comes from the message catalogue.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button } from '@lims/ui/components/Button';
import { t } from '@/core/i18n/messages';
import type { AccountParty, Named } from '../../server/accounts.server';
import { humanize } from '../format';

/** T0C-ACCT-1 permission codes (contracts/permissions.yaml). Every accounts page needs PERM.read (routes.yaml); the API enforces all four. */
export const PERM = {
  read: 'billing.account.read',
  manage: 'billing.account.manage',
  create: 'billing.account_entry.create',
  reverse: 'billing.account_entry.reverse',
} as const;

export const PAYMENT_MODES =['cash', 'cheque', 'bank_transfer', 'card', 'wallet'] as const;
/** T0B-ACCT-1: the API requires bank_name for these modes. */
export const BANK_MODES: readonly string[] = ['bank_transfer', 'cheque'];
export const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Contract pattern on reference_no / payment_details: no run of 13+ digits (card or account numbers). */
export const LONG_DIGITS = /[0-9]{13}/;

export const fill = (key: string, vars: Record<string, string>) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t(key));
const known = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
export const modeText = (m: string) => known(`billing.accounts.mode.${m}`, humanize(m));
export const statusText = (s: string) => known(`billing.accounts.status.${s}`, humanize(s));
export const typeText = (s: string) => t(`billing.accounts.type.${s}`);
export const sideText = (s: string) => t(`billing.accounts.side.${s}`);
/** T0D-UILIST-2 (LD-353 rule 6): ErrorState title of a failed list read (same wording as core/shell LoadError). */
export const LIST_FAILED = 'This list could not be loaded.';
export const nameOf =(list: readonly Named[] | readonly AccountParty[], id: string | undefined) => list.find((x) => x.id === id)?.name ?? '—';
export const newKey = () => crypto.randomUUID();

/** "1500.50" -> 150050 paisa; undefined when not a positive amount with at most 2 decimals. Pure string math, no float. */
export function toPaisa(text: string): number | undefined {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  const p = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return p >= 1 && Number.isSafeInteger(p) ? p : undefined;
}

/** Plain rupees for CSV ("1500.50"): spreadsheets must not see the lakh commas or the currency prefix. */
export function plainRupees(paisa: number): string {
  const s = String(Math.abs(Math.trunc(paisa))).padStart(3, '0');
  return `${paisa < 0 ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** One CSV cell: quoted, and a leading = + - @ tab or CR is neutralised with ' so a spreadsheet never runs it as a formula. */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${s.replace(/"/g, '""')}"`;
}
export function downloadCsv(fileName: string, rows: readonly (readonly string[])[]) {
  const blob = new Blob([`﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** T0D-UIX-4 (LD-442): the kit Button forwards no aria-* props, so the ARIA state attributes are set on its element (attribute values only). */
function useAria(ref: RefObject<HTMLElement | null>, attrs: Record<string, string | undefined>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  });
}

/**
 * Button that is disabled with a visible reason (founder 04:49 NPT: shown or disabled with a reason by permission). The reason is linked
 * with aria-describedby; pass reasonId when one reason on the page explains several buttons.
 */
export function GatedButton({ label, blocked, reasonId, onPress, variant = 'secondary' }: { label: string; blocked?: string | undefined; reasonId?: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const own = useId();
  const describedBy = blocked ? (reasonId ?? own) : undefined;
  const ref = useRef<HTMLButtonElement>(null);
  useAria(ref, { 'aria-describedby': describedBy });
  return (
    <>
      <Button ref={ref} variant={variant} size="sm" isDisabled={!!blocked} onPress={onPress}>{label}</Button>
      {blocked && !reasonId ? <span id={own} className="lims-description">{blocked}</span> : null}
    </>
  );
}

/**
 * Select-only listbox whose trigger is named by its label alone (value linked as description). The kit Select puts the chosen value into
 * the trigger name, so "Payment mode" = "Bank transfer" collided with the "Bank details" field label.
 * ponytail: click, Enter/Space, arrows and Esc only (no typeahead); move to the kit if it gains a label-only option.
 */
export function LabelOnlySelect<V extends string>({ label, value, options, onChange, error }: { label: string; value: V | undefined; options: readonly { value: V; label: string }[]; onChange: (v: V) => void; error?: string | undefined }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  useEffect(() => {
    if (!open) return;
    const all = items();
    (all.find((el) => el.getAttribute('aria-selected') === 'true') ?? all[0])?.focus();
  }, [open]);
  const choose = (v: V) => {
    onChange(v);
    setOpen(false);
    trigger.current?.focus();
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  };
  const current = options.find((o) => o.value === value);
  useAria(trigger, {
    'aria-haspopup': 'listbox',
    'aria-expanded': String(open),
    'aria-labelledby': `${id}-l`,
    'aria-describedby': error ? `${id}-v ${id}-e` : `${id}-v`,
    'aria-invalid': error ? 'true' : undefined,
  });
  return (
    <div className="lims-field">
      <span id={`${id}-l`} className="lims-label">{label}</span>
      {/* ArrowDown on the trigger opens the list (the kit Button takes no onKeyDown, so the wrapper listens; the key bubbles from the button). */}
      <span className="lims-select-trigger-wrap" onKeyDown={(e) => { if (e.key === 'ArrowDown' && e.target === trigger.current) { e.preventDefault(); setOpen(true); } }}>
        <Button ref={trigger} variant="secondary" onPress={() => setOpen((o) => !o)}>
          <span id={`${id}-v`}>{current?.label ?? ''}</span>
        </Button>
      </span>
      {open ? (
        // T0D-UIGUARD-1-BILLING (LD-436 R7, LD-439): the popover list is a div listbox (same roles), not a raw ul.
        <div ref={list} role="listbox" aria-labelledby={`${id}-l`} className="lims-popover lims-listbox" onKeyDown={onListKey}>
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              tabIndex={-1}
              className="lims-option"
              onClick={() => choose(o.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(o.value); } }}
            >
              {o.label}
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p id={`${id}-e`} className="lims-error">{error}</p> : null}
    </div>
  );
}


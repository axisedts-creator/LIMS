'use client';
// T0D-SALES-1 (LD-321, LD-353 template 1 LIST): shared parts of the four sales screens.
//   - SalesTable: the kit DataTable, compact; the header row is always drawn, an EmptyState or ErrorState sits in the body (LD-336, rules 5, 6);
//     cursor paging (Previous / Next, 100 rows a page) moves through the URL.
//   - Gated: a button that is disabled without partners.sales.manage and points (aria-describedby) at the one visible reason line of the page.
//   - DateInput: a native date input (no picker library) with its label and error.
import { useId, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button, type ButtonProps } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { t } from '@/core/i18n/messages';
import type { SalesResult } from '../server/salesActions';
import { errorText, hasPerm } from './common';

export const MANAGE = 'partners.sales.manage';
export const canManage = (permissions: readonly string[]) => hasPerm(permissions, MANAGE);
export const newKey = () => globalThis.crypto.randomUUID();
export const yesNo = (active: boolean) => t(active ? 'partners.sales.yes' : 'partners.sales.no');
export const NONE = '__none';

/** One request at a time: a second press while one runs is ignored (double click sends one request). */
export function useOnce() {
  const busy = useRef(false);
  return async (f: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try { await f(); } finally { busy.current = false; }
  };
}

/** Field messages of a refused write (path "/level" -> "level") and the dialog-level text for the rest. */
export function failure(r: Exclude<SalesResult, { ok: true }>, fields: readonly string[]): { fields: Record<string, string>; text?: string } {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (const e of r.errors ?? []) {
    const f = e.path.slice(1);
    if (fields.includes(f)) out[f] = e.message;
    else rest.push(e.message);
  }
  const text = rest.length ? rest.join(' ') : Object.keys(out).length ? undefined : errorText(r.code, r.status);
  return { fields: out, ...(text ? { text } : {}) };
}

export const Alert = ({ text }: { text?: string | undefined }) => (text ? <p role="alert" className="lims-error">{text}</p> : null);

/** The visible reason line every blocked control points at. */
export function useReason(manage: boolean) {
  const id = useId();
  return { id: manage ? undefined : id, line: manage ? null : <p id={id} className="lims-description">{t('partners.sales.reason.manage')}</p> };
}
export function Gated({ reasonId, children, ...props }: ButtonProps & { reasonId: string | undefined }) {
  if (!reasonId) return <Button {...props}>{children}</Button>;
  return <Button {...props} isDisabled ref={(el) => el?.setAttribute('aria-describedby', reasonId)}>{children}</Button>;
}

export function DateInput({ label, value, onChange, error, min, isRequired }: { label: string; value: string; onChange: (v: string) => void; error?: string | undefined; min?: string | undefined; isRequired?: boolean }) {
  const id = useId();
  return (
    <div className="lims-field">
      <label htmlFor={id} className="lims-label">{label}{isRequired ? <span aria-hidden="true"> *</span> : null}</label>
      <input
        id={id} type="date" className="lims-input" value={value} onChange={(e) => onChange(e.target.value)}
        {...(min ? { min } : {})} {...(isRequired ? { 'aria-required': true } : {})}
        {...(error ? { 'aria-invalid': true, 'aria-describedby': `${id}-e` } : {})}
      />
      {error ? <span id={`${id}-e`} className="lims-error">{error}</span> : null}
    </div>
  );
}

/** URL helpers: filters with router.replace, paging with router.push (cursor), Previous = back. */
export function useUrl() {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const go = (changes: Record<string, string | undefined>, push = false) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) (v ? p.set(k, v) : p.delete(k));
    const u = p.size ? `${path}?${p}` : path;
    if (push) router.push(u);
    else router.replace(u);
  };
  return { go, cursor: params.get('cursor') ?? undefined, back: () => router.back(), refresh: () => router.refresh() };
}

/** The Status filter of the three master screens (?is_active). */
export function StatusFilter({ value }: { value: string | undefined }) {
  const url = useUrl();
  const options = [{ value: 'true', label: t('partners.sales.status.active') }, { value: 'false', label: t('partners.sales.status.inactive') }];
  return (
    <FilterBar
      filters={[{ id: 'is_active', label: t('partners.sales.status'), kind: 'select', options }]}
      value={value ? { is_active: value } : {}}
      onChange={(v) => { const s = typeof v['is_active'] === 'string' ? v['is_active'] : undefined; if (s !== value) url.go({ is_active: s, cursor: undefined }); }}
      onReset={() => url.go({ is_active: undefined, cursor: undefined })}
    />
  );
}

/** Confirm, then run one write (deactivate / unassign); a refusal stays in the dialog as a plain sentence. `children` = extra fields; `check` refuses in the browser. */
export function ConfirmWrite({ title, body, confirm, onClose, onDone, act, check, children }: {
  title: string; body: string; confirm: string; onClose: () => void; onDone: () => void;
  act: () => Promise<SalesResult>; check?: () => boolean; children?: ReactNode;
}) {
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const once = useOnce();
  const go = () => once(async () => {
    if (check && !check()) return;
    setBusy(true);
    setText(undefined);
    try {
      const r = await act();
      if (r.ok) return onDone();
      setText(failure(r, []).text);
    } finally {
      setBusy(false);
    }
  });
  return (
    <Dialog title={title} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.sales.cancel')}</Button><Button variant="danger" isLoading={busy} onPress={() => void go()}>{confirm}</Button></>}>
      <div className="lims-stack">
        <p className="lims-description">{body}</p>
        {children}
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export type Col<R> = ColumnDef<R>;
/** The kit DataTable (compact, cut off cells titled) with the LD-336 empty and failed states. The wrapper carries `sales-empty-state` while the
 * body shows the EmptyState, so the empty table can be told apart from a loaded one without reading the text. */
export function SalesTable<R>({ caption, columns, rows, getRowId, empty, failed, nextCursor }: {
  caption: string;
  columns: readonly Col<R>[];
  rows: readonly R[];
  getRowId: (r: R) => string;
  empty: { title: string; body: string };
  /** The list read failed: the header row stays and the ErrorState with Retry sits in the body. */
  failed?: string | undefined;
  nextCursor?: string | undefined;
}) {
  const url = useUrl();
  // a trailing space ends every cell so a row reads as words ("1 Synthetic Regional Head Yes"), also for copy and screen readers; text cells keep their title
  const spaced = columns.map((c) => ({ ...c, cell: (r: R) => { const v = c.cell(r); return typeof v === 'string' || typeof v === 'number' ? `${v} ` : <>{v}{' '}</>; } }));
  return (
    <div className={!failed && rows.length === 0 ? 'sales-empty-state' : undefined} {...(failed ? { role: 'alert' } : {})}>
      <DataTable<R>
        caption={caption} columns={spaced} rows={rows} getRowId={getRowId} density="compact" cellTitle emptyState={empty}
        {...(failed ? { error: { title: failed, onRetry: url.refresh } } : {})}
        {...(nextCursor || url.cursor ? { page: { hasNext: !!nextCursor, hasPrevious: !!url.cursor, onNext: () => url.go({ cursor: nextCursor }, true), onPrevious: url.back, limit: 100 } } : {})}
      />
    </div>
  );
}

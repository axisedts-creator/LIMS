'use client';
// Shared pieces of the SCR-02…05 master screens (04-UI-UX §3/§4): list table, toolbar (search + status), list shortcuts
// (`/`, `n`), and the editor dialog (Ctrl+S, one Idempotency-Key per open, 409 handling). Manage affordances are a UI hint; the API enforces.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Form } from '@lims/ui/components/Form';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import type { ActionResult } from '../server/types';

export const canManage = (permissions: readonly string[]) => permissions.includes('catalog.test.manage');
export const statusText = (active: boolean) => (active ? 'Active' : 'Inactive');
export const CODE_HINT = 'Pattern ^[A-Z0-9][A-Z0-9_]{0,31}$: capital letters A-Z0-9 and _, up to 32.'; // [CONV] hint wording
export const DUPLICATE = 'This code is already used.';
const CONFLICT = 'Someone else changed this item. Reload to see their changes.';

/** Only the fields that differ from the loaded item (PATCH never re-sends untouched fields). */
export function changed<T extends object>(before: T, after: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(after) as (keyof T)[]) if (after[k] !== before[k]) out[k] = after[k];
  return out;
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"]');

/** `/` focuses the search, `n` opens New (when given). Ignored while typing or while a dialog is open. */
export function useListShortcuts(search: { current: HTMLElement | null }, onNew: (() => void) | undefined) {
  const latest = useRef(onNew);
  latest.current = onNew;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector('[role="dialog"]')) return;
      if (e.key === '/' && search.current) {
        e.preventDefault();
        search.current.querySelector('input')?.focus();
      } else if (e.key === 'n' && latest.current) {
        e.preventDefault();
        latest.current();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [search]);
}

export type StatusFilter = 'all' | 'active' | 'inactive';

/** Search (code/name, client-side over the loaded ≤ 200 rows [CONV]) + Status filter. */
export function useListFilter<R extends { code: string; is_active: boolean }>(rows: readonly R[], text: (r: R) => string) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const search = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) => (status === 'all' || r.is_active === (status === 'active')) && (!needle || r.code.toLowerCase().includes(needle) || text(r).toLowerCase().includes(needle)),
  );
  const toolbar = (
    <div className="lims-filter-bar">
      <div ref={search}>
        <TextField label="Search" name="q" maxLength={100} value={q} onChange={setQ} />
      </div>
      <RadioGroup<StatusFilter>
        label="Status"
        name="status"
        orientation="horizontal"
        value={status}
        onChange={setStatus}
        options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]}
      />
    </div>
  );
  return { shown, toolbar, search };
}

export interface Col<R> { header: string; cell: (r: R) => ReactNode }

/** Plain table (role=table; rows named by their content). `onEdit` undefined or `canEdit` false = no Edit button for the row. */
export function MasterTable<R extends { id: string; code: string }>({ caption, cols, rows, empty, emptyAction, onEdit, canEdit = () => true, rowExtra }: {
  caption: string;
  cols: readonly Col<R>[];
  rows: readonly R[];
  empty: string;
  emptyAction?: { label: string; onPress: () => void } | undefined;
  onEdit?: ((r: R) => void) | undefined;
  canEdit?: (r: R) => boolean;
  rowExtra?: (r: R) => ReactNode;
}) {
  if (rows.length === 0) return <EmptyState title={empty} {...(emptyAction ? { action: emptyAction } : {})} />;
  const actions = !!onEdit || !!rowExtra;
  return (
    <table className="lims-table lims-table-regular">
      <caption className="lims-visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.header} scope="col" className="lims-col">{c.header}</th>
          ))}
          {actions ? <th scope="col" className="lims-col-actions"><VisuallyHidden>Actions</VisuallyHidden></th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="lims-row">
            {cols.map((c) => (
              <td key={c.header} className="lims-cell">{c.cell(r)}</td>
            ))}
            {actions ? (
              <td className="lims-cell-actions">
                {rowExtra?.(r)}
                {onEdit && canEdit(r) ? (
                  <Button size="sm" variant="ghost" onPress={() => onEdit(r)}>
                    Edit<VisuallyHidden> {r.code}</VisuallyHidden>
                  </Button>
                ) : null}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Editor dialog: Save / Ctrl+S submit the form once at a time; one Idempotency-Key per open (a retry after a failure is the
 * same create, 02-CONVENTIONS §4.5); success → toast + refresh + close; 409 duplicate → onDuplicate (inline on Code);
 * 409 version_conflict → Banner + Reload, input kept; 409 version_in_use → onInUse + Banner. Failures stay inline:
 * a toast behind the modal is aria-hidden. Raw problem detail is never shown.
 */
export function EditorDialog({ title, savedText, onClose, check, save, onDuplicate, onInUse, inUseText, children }: {
  title: string;
  savedText: string;
  onClose: () => void;
  /** Extra client checks; false blocks the request (the screen shows its own field errors). */
  check?: () => boolean;
  save: (idempotencyKey: string) => Promise<ActionResult<unknown>>;
  onDuplicate: () => void;
  onInUse?: () => void;
  inUseText?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [banner, setBanner] = useState<'conflict' | 'in_use' | 'error' | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        wrap.current?.querySelector('form')?.requestSubmit();
      }
    };
    document.addEventListener('keydown', h, true);
    return () => document.removeEventListener('keydown', h, true);
  }, []);

  const submit = async () => {
    if (done.current || (check && !check())) return;
    setBanner(null);
    const r = await save(key);
    if (r.ok) {
      done.current = true;
      onClose();
      toast.show({ tone: 'success', title: savedText });
      router.refresh();
    } else if (r.code === 'catalog.code_duplicate') onDuplicate();
    else if (r.code === 'common.version_conflict') setBanner('conflict');
    else if (r.code === 'catalog.version_in_use' && onInUse) {
      onInUse();
      setBanner('in_use');
    } else setBanner('error');
  };

  return (
    <Dialog title={title} isOpen onClose={onClose} size="md">
      <div ref={wrap}>
        <Form onSubmit={submit}>
          {banner === 'conflict' ? <Banner tone="warning" title={CONFLICT} action={{ label: 'Reload', onPress: () => router.refresh() }} /> : null}
          {banner === 'in_use' ? <Banner tone="info" title={inUseText ?? ''} /> : null}
          {banner === 'error' ? (
            <div role="alert">
              <Banner tone="danger" title="Could not save. Try again." />
            </div>
          ) : null}
          {children}
          <Button type="submit" variant="primary" shortcut="Ctrl+S">Save</Button>
        </Form>
      </div>
    </Dialog>
  );
}

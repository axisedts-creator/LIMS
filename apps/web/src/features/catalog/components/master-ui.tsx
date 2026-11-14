'use client';
// Shared pieces of the SCR-02…05 master screens (04-UI-UX §3/§4): list table, toolbar (search + status), list shortcuts
// (`/`, `n`), and the editor dialog (Ctrl+S, one Idempotency-Key per open, 409 handling). Manage affordances are a UI hint; the API enforces.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Drawer } from '@lims/ui/components/Drawer';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Form } from '@lims/ui/components/Form';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import type { ActionResult } from '../server/types';
import './catalog.css';

export const canManage = (permissions: readonly string[]) => permissions.includes('catalog.test.manage');
export const statusText = (active: boolean) => (active ? 'Active' : 'Inactive');
export const StatusBadge = ({ active }: { active: boolean }) => <Badge tone={active ? 'success' : 'neutral'}>{statusText(active)}</Badge>;
export const CODE_HINT = 'Pattern ^[A-Z0-9][A-Z0-9_]{0,31}$: capital letters A-Z0-9 and _, up to 32.'; // [CONV] hint wording
export const DUPLICATE = 'This code is already used.';
export const CONFLICT = 'Someone else changed this item. Reload to see their changes.';
export const MFA = 'This change needs a second factor. Verify your identity (multi-factor sign-in), then try again.';

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
export function MasterTable<R extends { id: string }>({ caption, cols, rows, empty, emptyAction, onEdit, canEdit = () => true, rowExtra, codeOf = (r) => (r as { code?: string }).code ?? '' }: {
  caption: string;
  /** Code shown (visually hidden) after the Edit button so each Edit has a unique name. */
  codeOf?: (r: R) => string;
  cols: readonly Col<R>[];
  rows: readonly R[];
  empty: string;
  emptyAction?: { label: string; onPress: () => void } | undefined;
  onEdit?: ((r: R) => void) | undefined;
  canEdit?: (r: R) => boolean;
  rowExtra?: ((r: R) => ReactNode) | undefined;
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
                    Edit<VisuallyHidden> {codeOf(r)}</VisuallyHidden>
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
 * Save form: Save / Ctrl+S submit the form once at a time; one Idempotency-Key per mount (a retry after a failure is the
 * same create, 02-CONVENTIONS §4.5); success → toast + refresh + done; 409 duplicate → onDuplicate (inline on Code);
 * 409 version_conflict → Banner + Reload, input kept; 409 version_in_use → onInUse + Banner; 403 auth.mfa_required → step-up
 * message. Failures stay inline: a toast behind a modal is aria-hidden. Raw problem detail is never shown.
 * `keepOpen` = an in-page form (detail screens): it can be saved again after a success.
 */
export function SaveForm({ savedText, onDone, check, save, onSaved, onDuplicate, onInUse, inUseText, keepOpen, reloadLabel = 'Reload', children }: {
  savedText: string;
  /** Label of the conflict banner's refresh button. */
  reloadLabel?: string;
  onDone?: () => void;
  /** Extra client checks; false blocks the request (the screen shows its own field errors). */
  check?: () => boolean;
  save: (idempotencyKey: string) => Promise<ActionResult<unknown>>;
  /** Called with the saved entity (before the form closes), e.g. to surface possible duplicates. */
  onSaved?: (data: unknown) => void;
  onDuplicate: () => void;
  onInUse?: () => void;
  inUseText?: string;
  keepOpen?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [banner, setBanner] = useState<'conflict' | 'in_use' | 'mfa' | 'duplicate' | 'error' | null>(null);
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
      done.current = !keepOpen;
      onSaved?.(r.data);
      onDone?.();
      toast.show({ tone: 'success', title: savedText });
      router.refresh();
    } else if (r.code === 'catalog.code_duplicate') {
      onDuplicate();
      setBanner('duplicate');
    }
    else if (r.code === 'common.version_conflict') setBanner('conflict');
    else if (r.code === 'auth.mfa_required') setBanner('mfa');
    else if (r.code === 'catalog.version_in_use' && onInUse) {
      onInUse();
      setBanner('in_use');
    } else setBanner('error');
  };

  return (
    <div ref={wrap}>
      <Form onSubmit={submit}>
        {banner === 'conflict' ? <Banner tone="warning" title={CONFLICT} action={{ label: reloadLabel, onPress: () => router.refresh() }} /> : null}
        {banner === 'in_use' ? <Banner tone="info" title={inUseText ?? ''} /> : null}
        {banner === 'duplicate' ? (
          <div role="alert">
            <Banner tone="danger" title="The code is already in use. Choose another code." />
          </div>
        ) : null}
        {banner === 'mfa' ? (
          <div role="alert">
            <Banner tone="warning" title={MFA} />
          </div>
        ) : null}
        {banner === 'error' ? (
          <div role="alert">
            <Banner tone="danger" title="Could not save. Try again." />
          </div>
        ) : null}
        {keepOpen ? (
          <>
            {children}
            <Button type="submit" variant="primary" shortcut="Ctrl+S">Save</Button>
          </>
        ) : (
          <FormSection title="Details" action={<Button type="submit" size="sm" variant="primary" shortcut="Ctrl+S">Save</Button>}>
            {children}
          </FormSection>
        )}
      </Form>
    </div>
  );
}

/**
 * One drawer section with its own Save (LD-140, 10-DESIGN-SYSTEM §4). Same markup as the kit `DrawerSection`, but the Save button
 * is a plain "Save" (the chunk tests find it by that exact name) and it submits the surrounding form, so Ctrl+S and the button
 * share one path. `action` is the Save button.
 */
export function FormSection({ title, action, children }: { title: string; action: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="lims-drawer-section" aria-labelledby={id}>
      <div className="lims-drawer-section-header">
        <h3 id={id} className="lims-drawer-section-title">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Editor drawer (LD-140, 10-DESIGN-SYSTEM §4 Masters): SaveForm in a kit Drawer, one section with its own Save; Esc / close = onClose. */
export function EditorDialog({ title, onClose, width = 'md', ...rest }: { title: string; onClose: () => void; width?: 'sm' | 'md' | 'lg' } & Omit<Parameters<typeof SaveForm>[0], 'onDone' | 'keepOpen'>) {
  return (
    <Drawer title={title} isOpen onClose={onClose} width={width}>
      <SaveForm {...rest} onDone={onClose} />
    </Drawer>
  );
}

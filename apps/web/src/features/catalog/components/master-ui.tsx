'use client';
// Shared pieces of the SCR-02…05 master screens (04-UI-UX §3/§4): list table, toolbar (search + status), list shortcuts
// (`/`, `n`), and the editor dialog (Ctrl+S, one Idempotency-Key per open, 409 handling). Manage affordances are a UI hint; the API enforces.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { Drawer, DrawerSection } from '@lims/ui/components/Drawer';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FilterBar, type FilterDef, type FilterValue } from '@lims/ui/components/FilterBar';
import { Form } from '@lims/ui/components/Form';
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

/** A further select of the one filter row: its first option is the "all" value (the default and the reset value). */
export type ExtraFilter = { id: string; label: string; options: readonly { value: string; label: string }[] };
const STATUS_OPTIONS = [{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] as const;

/** Search (code/name, client-side over the loaded ≤ 200 rows [CONV]) + Status filter. */
// T0D-UILIST-3: `extra` = further filters of the screen, drawn in the same one-row bar (LD-353 template 1).
// T0D-UIGUARD-1-CATALOG (LD-353 rule 2, LD-436 worklist mock): the row is the kit FilterBar (search, selects, "Clear filters").
// `values[id]` is the chosen value of each extra filter; the caller filters its rows by it.
export function useListFilter<R extends { is_active: boolean }>(rows: readonly R[], text: (r: R) => string, extra: readonly ExtraFilter[] = [], code: (r: R) => string = (r) => (r as { code?: string }).code ?? '') {
  const initial = (): FilterValue => Object.fromEntries([['status', 'all'], ...extra.map((f) => [f.id, f.options[0]?.value])]);
  const [value, setValue] = useState<FilterValue>(initial);
  const search = useRef<HTMLDivElement>(null);
  const str = (id: string) => (typeof value[id] === 'string' ? (value[id] as string) : '');
  const status = (str('status') || 'all') as StatusFilter;
  const needle = str('q').trim().toLowerCase();
  const shown = rows.filter(
    (r) => (status === 'all' || r.is_active === (status === 'active')) && (!needle || code(r).toLowerCase().includes(needle) || text(r).toLowerCase().includes(needle)),
  );
  const filters: FilterDef[] = [
    { id: 'q', label: 'Search', kind: 'text', maxLength: 100 },
    { id: 'status', label: 'Status', kind: 'select', options: STATUS_OPTIONS },
    ...extra.map((f): FilterDef => ({ id: f.id, label: f.label, kind: 'select', options: f.options })),
  ];
  const values: Record<string, string> = Object.fromEntries(extra.map((f) => [f.id, str(f.id) || (f.options[0]?.value ?? '')]));
  const toolbar = (
    <div ref={search}>
      <FilterBar filters={filters} value={value} onChange={setValue} onReset={() => setValue(initial())} resetLabel="Clear filters" />
    </div>
  );
  return { shown, toolbar, search, values };
}

export interface Col<R> { header: string; cell: (r: R) => ReactNode }

// ponytail: plain-text heuristics (a digits-only code column also aligns right); a per-column `align` prop if that ever reads wrong.
const NUMBER = /^-?[\d,]+(\.\d+)?$/;
const isNumberColumn = (vs: readonly ReactNode[]) => vs.length > 0 && vs.every((v) => (typeof v === 'string' || typeof v === 'number') && NUMBER.test(String(v).trim()));
const cutOff = (v: ReactNode) => typeof v === 'string' && v.length > 32;

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
  // LD-310 (T0D-CATUNITS-1): headers are drawn even with no rows; the empty state sits in the single body row.
  const actions = rows.length > 0 && (!!onEdit || !!rowExtra);
  // T0D-UNSLOP-1 (LD-353 rules 3 and 5): an all-number column is right aligned (header too); a long text cell carries its full value as title.
  const vals = rows.map((r) => cols.map((c) => c.cell(r)));
  const end = cols.map((_, i) => (isNumberColumn(vals.map((v) => v[i])) ? ' lims-align-end' : ''));
  // T0D-UILIST-3, LD-353 rule 5: the table scrolls inside the kit box, never the page.
  return (
    <div className="lims-table-scroll">
    <table className="lims-table lims-table-regular">
      <caption className="lims-visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={c.header} scope="col" className={`lims-col${end[i]}`}>{c.header}</th>
          ))}
          {actions ? <th scope="col" className="lims-col-actions"><VisuallyHidden>Actions</VisuallyHidden></th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          // T0D-EMPTYTBL-1 (LD-310): message row (create action repeated) + four placeholder rows.
          <EmptyRow colSpan={cols.length}><EmptyState title={empty} {...(emptyAction ? { action: emptyAction } : {})} /></EmptyRow>
        ) : null}
        {rows.map((r, ri) => (
          <tr key={(r.id as string | undefined) ?? `global:${codeOf(r)}`/* global units/value sets carry no id (catalog.yaml) */} className="lims-row">
            {cols.map((c, i) => {
              const v = vals[ri]![i];
              return <td key={c.header} className={`lims-cell${end[i]}`} {...(cutOff(v) ? { title: v as string } : {})}>{v}</td>;
            })}
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
      {rows.length === 0 ? <PlaceholderRows colSpan={cols.length} /> : null}
    </table>
    </div>
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
// T0D-UIGUARD-1-CATALOG (LD-436 R7): the kit DrawerSection draws the section heading; `action` (additive kit prop) carries the submit Save.
export function FormSection({ title, action, children }: { title: string; action: ReactNode; children: ReactNode }) {
  return <DrawerSection title={title} action={action}>{children}</DrawerSection>;
}

/** Editor drawer (LD-140, 10-DESIGN-SYSTEM §4 Masters): SaveForm in a kit Drawer, one section with its own Save; Esc / close = onClose. */
export function EditorDialog({ title, onClose, width = 'md', ...rest }: { title: string; onClose: () => void; width?: 'sm' | 'md' | 'lg' } & Omit<Parameters<typeof SaveForm>[0], 'onDone' | 'keepOpen'>) {
  return (
    <Drawer title={title} isOpen onClose={onClose} width={width}>
      <SaveForm {...rest} onDone={onClose} />
    </Drawer>
  );
}

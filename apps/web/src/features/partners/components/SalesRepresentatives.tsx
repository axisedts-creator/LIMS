'use client';
// T0D-SALES-1 (LD-321, LD-353 template 1 LIST): ElabAssist Sales Representative. Columns Name, Designation, Manager, Phone, Email, Joining Date, Active;
// tabs List and Tree (the manager tree, role=tree with arrow keys). The manager picker hides invalid choices: the person, the whole team below it
// (a loop) and inactive representatives; the server refuses a loop on /manager_id as the last word. Edit sends only the changed fields; a cleared
// optional field goes through `unset`.
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { SalesDesignation, SalesRepresentative, SalesTreeNode } from '../server/sales.server';
import { createRepresentativeAction, deactivateRepresentativeAction, updateRepresentativeAction } from '../server/salesActions';
import { Alert, ConfirmWrite, DateInput, Gated, NONE, SalesTable, StatusFilter, canManage, failure, newKey, useOnce, useReason, useUrl, yesNo, type Col } from './SalesCommon';

const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ['name', 'phone', 'email', 'designation_id', 'manager_id', 'joining_date'] as const;
const OPTIONAL = ['phone', 'email', 'manager_id', 'joining_date'] as const;

/** Every id below `id` in the tree (its whole team). */
function teamOf(id: string, nodes: readonly SalesTreeNode[]): Set<string> {
  const kids = new Map<string, string[]>();
  for (const n of nodes) if (n.manager_id) kids.set(n.manager_id, [...(kids.get(n.manager_id) ?? []), n.id]);
  const out = new Set<string>();
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (out.has(x)) continue; // a bad tree from the server must not loop here
    out.add(x);
    stack.push(...(kids.get(x) ?? []));
  }
  return out;
}

function RepresentativeDialog({ row, designations, tree, onClose, onDone }: {
  row?: SalesRepresentative | undefined; designations: readonly SalesDesignation[]; tree: readonly SalesTreeNode[]; onClose: () => void; onDone: () => void;
}) {
  const [v, setV] = useState<Record<(typeof FIELDS)[number], string>>({
    name: row?.name ?? '', phone: row?.phone ?? '', email: row?.email ?? '', designation_id: row?.designation_id ?? '', manager_id: row?.manager_id ?? NONE, joining_date: row?.joining_date ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const once = useOnce();
  const [key] = useState(newKey);
  const set = (k: (typeof FIELDS)[number]) => (x: string) => setV((o) => ({ ...o, [k]: x }));

  const team = row ? teamOf(row.id, tree) : new Set<string>();
  const managers = [{ value: NONE, label: t('partners.sales.no_manager') }, ...tree.filter((n) => n.is_active && n.id !== row?.id && !team.has(n.id)).map((n) => ({ value: n.id, label: n.name }))];
  const grades = designations.filter((d) => d.is_active || d.id === row?.designation_id).map((d) => ({ value: d.id, label: `${d.level} ${d.name}` }));

  const save = () => once(async () => {
    const val = { ...v, name: v.name.trim(), phone: v.phone.trim(), email: v.email.trim(), manager_id: v.manager_id === NONE ? '' : v.manager_id };
    const e: Record<string, string> = {};
    if (!val.name) e['name'] = t('partners.sales.error.name');
    else if (val.name.length > 200) e['name'] = t('partners.sales.error.too_long');
    if (!val.designation_id) e['designation_id'] = t('partners.sales.error.choose');
    if (val.phone && !PHONE.test(val.phone)) e['phone'] = t('partners.sales.error.phone');
    if (val.email && (val.email.length > 254 || !EMAIL.test(val.email))) e['email'] = t('partners.sales.error.email');
    setErrors(e);
    setText(undefined);
    if (Object.keys(e).length) return;
    let body: Record<string, unknown>;
    if (row) {
      const was: Record<string, string> = { name: row.name, phone: row.phone ?? '', email: row.email ?? '', designation_id: row.designation_id, manager_id: row.manager_id ?? '', joining_date: row.joining_date ?? '' };
      body = {};
      const unset: string[] = [];
      for (const k of FIELDS) {
        if (val[k] === was[k]) continue;
        if (val[k] === '' && (OPTIONAL as readonly string[]).includes(k)) unset.push(k);
        else body[k] = val[k];
      }
      if (unset.length) body['unset'] = unset;
      if (Object.keys(body).length === 0) return onClose();
    } else {
      body = Object.fromEntries(FIELDS.filter((k) => val[k] !== '').map((k) => [k, val[k]]));
    }
    setBusy(true);
    try {
      const r = row ? await updateRepresentativeAction(row.id, row.version, body) : await createRepresentativeAction(body, key);
      if (r.ok) return onDone();
      const f = failure(r, FIELDS);
      setErrors(f.fields);
      setText(f.text);
    } finally {
      setBusy(false);
    }
  });

  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  return (
    <Dialog title={t(row ? 'partners.sales.reps.edit_title' : 'partners.sales.reps.add')} isOpen onClose={onClose} size="md"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.sales.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.sales.save')}</Button></>}>
      <div className="lims-stack">
        <TextField label={t('partners.sales.field.name')} name="name" maxLength={200} isRequired value={v.name} onChange={set('name')} {...err('name')} />
        <Select label={t('partners.sales.field.designation')} name="designation_id" isRequired options={grades} {...(v.designation_id ? { value: v.designation_id } : {})} onChange={set('designation_id')} {...err('designation_id')} />
        <Select label={t('partners.sales.field.manager')} name="manager_id" options={managers} value={v.manager_id} onChange={set('manager_id')} {...err('manager_id')} />
        <TextField label={t('partners.sales.field.phone')} name="phone" maxLength={24} inputMode="tel" value={v.phone} onChange={set('phone')} {...err('phone')} />
        <TextField label={t('partners.sales.field.email')} name="email" maxLength={254} inputMode="email" value={v.email} onChange={set('email')} {...err('email')} />
        <DateInput label={t('partners.sales.field.joining_date')} value={v.joining_date} onChange={set('joining_date')} error={errors['joining_date']} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

/** The manager tree (APG tree view): roving focus, ArrowDown / ArrowUp move, ArrowLeft collapses, ArrowRight expands. Nodes come depth first from getSalesTree. */
function ManagerTree({ nodes }: { nodes: readonly SalesTreeNode[] }) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<string | undefined>(nodes[0]?.id);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const parents = useMemo(() => new Set(nodes.flatMap((n) => (n.manager_id ? [n.manager_id] : []))), [nodes]);
  const hidden = (n: SalesTreeNode) => {
    const seen = new Set<string>();
    for (let m = n.manager_id; m && !seen.has(m); m = byId.get(m)?.manager_id) { if (closed.has(m)) return true; seen.add(m); }
    return false;
  };
  const shown = nodes.filter((n) => !hidden(n));
  if (nodes.length === 0) return <p className="lims-description">{t('partners.sales.reps.tree_empty')}</p>;

  const move = (id: string | undefined) => { if (!id) return; setFocus(id); refs.current.get(id)?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).dataset['id'];
    const i = shown.findIndex((n) => n.id === id);
    if (i < 0) return;
    const n = shown[i]!;
    const toggle = (open: boolean) => setClosed((c) => { const x = new Set(c); if (open) x.delete(n.id); else x.add(n.id); return x; });
    if (e.key === 'ArrowDown') move(shown[i + 1]?.id);
    else if (e.key === 'ArrowUp') move(shown[i - 1]?.id);
    else if (e.key === 'Home') move(shown[0]?.id);
    else if (e.key === 'End') move(shown.at(-1)?.id);
    else if (e.key === 'ArrowLeft') { if (parents.has(n.id) && !closed.has(n.id)) toggle(false); else move(n.manager_id); }
    else if (e.key === 'ArrowRight') { if (parents.has(n.id) && closed.has(n.id)) toggle(true); }
    else return;
    e.preventDefault();
  };
  const current = shown.some((n) => n.id === focus) ? focus : shown[0]?.id;
  // nested role=group lists (APG tree): the nesting indents each team (shell.css .lims-tree-group); a collapsed node renders no group.
  // T0D-UIGUARD-1-PARTNERS (LD-436/LD-439 rule 7): ARIA tree roles on div, no raw ul for page structure; roles and keys unchanged.
  const item = (n: SalesTreeNode): ReactNode => (
    <div
      key={n.id} role="treeitem" data-id={n.id} aria-level={n.depth} tabIndex={n.id === current ? 0 : -1}
      {...(parents.has(n.id) ? { 'aria-expanded': !closed.has(n.id) } : {})}
      ref={(el) => { if (el) refs.current.set(n.id, el); else refs.current.delete(n.id); }}
      onFocus={(e) => { if (e.target === e.currentTarget) setFocus(n.id); }}
    >
      <span>{n.name}{n.is_active ? null : <span className="lims-description"> ({t('partners.sales.inactive')})</span>}</span>
      {parents.has(n.id) && !closed.has(n.id) ? <div role="group" className="lims-tree-group">{shown.filter((c) => c.manager_id === n.id).map(item)}</div> : null}
    </div>
  );
  return (
    <div role="tree" aria-label={t('partners.sales.reps.tree')} className="lims-tree" onKeyDown={onKey}>
      {shown.filter((n) => !n.manager_id || !byId.has(n.manager_id)).map(item)}
    </div>
  );
}

export function SalesRepresentatives({ rows, designations, tree, failed, nextCursor, isActive, permissions }: {
  rows: readonly SalesRepresentative[];
  designations: readonly SalesDesignation[];
  tree: readonly SalesTreeNode[];
  failed?: string | undefined;
  nextCursor?: string | undefined;
  isActive?: string | undefined;
  permissions: readonly string[];
}) {
  const manage = canManage(permissions);
  const reason = useReason(manage);
  const toast = useToast();
  const url = useUrl();
  const [tab, setTab] = useState('list');
  const [editing, setEditing] = useState<SalesRepresentative | 'new' | null>(null);
  const [leaving, setLeaving] = useState<SalesRepresentative | null>(null);
  const grade = new Map(designations.map((d) => [d.id, d.name]));
  const name = new Map([...tree.map((n) => [n.id, n.name] as const), ...rows.map((r) => [r.id, r.name] as const)]);

  const done = (msg: string) => { setEditing(null); setLeaving(null); toast.show({ tone: 'success', title: msg }); url.refresh(); };
  const columns: Col<SalesRepresentative>[] = [
    { id: 'name', header: t('partners.sales.col.name'), isRowHeader: true, cell: (r) => r.name },
    { id: 'designation', header: t('partners.sales.col.designation'), cell: (r) => grade.get(r.designation_id) ?? '—' },
    { id: 'manager', header: t('partners.sales.col.manager'), cell: (r) => (r.manager_id ? name.get(r.manager_id) ?? '—' : '—') },
    { id: 'phone', header: t('partners.sales.col.phone'), cell: (r) => r.phone ?? '—' },
    { id: 'email', header: t('partners.sales.col.email'), cell: (r) => r.email ?? '—' },
    { id: 'joining', header: t('partners.sales.col.joining_date'), cell: (r) => r.joining_date ?? '—' },
    { id: 'active', header: t('partners.sales.col.active'), cell: (r) => yesNo(r.is_active) },
    {
      id: 'actions', header: t('partners.sales.col.actions'),
      cell: (r) => (
        <span className="lims-inline">
          <Gated size="sm" variant="ghost" reasonId={reason.id} onPress={() => setEditing(r)}>{t('partners.sales.edit')}</Gated>
          {r.is_active ? <Gated size="sm" variant="ghost" reasonId={reason.id} onPress={() => setLeaving(r)}>{t('partners.sales.deactivate')}</Gated> : null}
        </span>
      ),
    },
  ];

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.sales_representatives')} helpKey="partners.sales.representatives"
        actions={<Gated variant="primary" reasonId={reason.id} onPress={() => setEditing('new')}>{t('partners.sales.reps.add')}</Gated>} />
      {reason.line}
      <StatusFilter value={isActive} />
      <Tabs aria-label={t('partners.nav.sales_representatives')} selectedId={tab} onChange={setTab}
        items={[{ id: 'list', label: t('partners.sales.reps.tab.list') }, { id: 'tree', label: t('partners.sales.reps.tab.tree') }]}>
        {tab === 'list' ? (
          <SalesTable caption={t('partners.nav.sales_representatives')} columns={columns} rows={rows} getRowId={(r) => r.id} failed={failed} nextCursor={nextCursor}
            empty={{ title: t('partners.sales.reps.empty'), body: t('partners.sales.reps.empty_hint') }} />
        ) : (
          <ManagerTree nodes={tree} />
        )}
      </Tabs>
      {editing ? <RepresentativeDialog row={editing === 'new' ? undefined : editing} designations={designations} tree={tree} onClose={() => setEditing(null)} onDone={() => done(t('partners.sales.saved'))} /> : null}
      {leaving ? (
        <ConfirmWrite title={`${t('partners.sales.reps.deactivate_title')}: ${leaving.name}`} body={t('partners.sales.reps.deactivate_body')} confirm={t('partners.sales.deactivate')}
          act={() => deactivateRepresentativeAction(leaving.id, leaving.version)} onClose={() => setLeaving(null)} onDone={() => done(t('partners.sales.deactivated'))} />
      ) : null}
    </section>
  );
}

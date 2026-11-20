'use client';
// T0D-SALES-1 (LD-321, LD-353 template 1 LIST): ElabAssist Sales Designation. Columns Level, Name, Active; Add / Edit in a dialog, Deactivate / Activate on the row.
// Levels are whole numbers 1 to 8 (1 = top), unique per tenant: the server refuses a used level on /level and the dialog shows it on the field.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { SalesDesignation } from '../server/sales.server';
import { createDesignationAction, updateDesignationAction } from '../server/salesActions';
import { Alert, Gated, SalesTable, StatusFilter, canManage, failure, newKey, useOnce, useReason, useUrl, yesNo, type Col } from './SalesCommon';

const LEVEL = /^[1-8]$/;

function DesignationDialog({ row, onClose, onDone }: { row?: SalesDesignation | undefined; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(row?.name ?? '');
  const [level, setLevel] = useState(row ? String(row.level) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const once = useOnce();
  const [key] = useState(newKey);

  const save = () => once(async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e['name'] = t('partners.sales.error.name');
    if (!LEVEL.test(level.trim())) e['level'] = t('partners.sales.error.level');
    setErrors(e);
    setText(undefined);
    if (Object.keys(e).length) return;
    const lv = Number(level.trim());
    const change = row ? { ...(name.trim() !== row.name ? { name: name.trim() } : {}), ...(lv !== row.level ? { level: lv } : {}) } : undefined;
    if (change && Object.keys(change).length === 0) return onClose();
    setBusy(true);
    try {
      const r = row ? await updateDesignationAction(row.id, row.version, change!) : await createDesignationAction({ name: name.trim(), level: lv }, key);
      if (r.ok) return onDone();
      const f = failure(r, ['name', 'level']);
      setErrors(f.fields);
      setText(f.text);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Dialog title={t(row ? 'partners.sales.designations.edit_title' : 'partners.sales.designations.add')} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.sales.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.sales.save')}</Button></>}>
      <div className="lims-stack">
        <TextField label={t('partners.sales.field.name')} name="name" maxLength={120} isRequired value={name} onChange={setName} {...(errors['name'] ? { error: errors['name'] } : {})} />
        <TextField label={t('partners.sales.field.level')} name="level" maxLength={4} inputMode="numeric" isRequired description={t('partners.sales.designations.level_hint')} value={level} onChange={setLevel} {...(errors['level'] ? { error: errors['level'] } : {})} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export function SalesDesignations({ rows, failed, nextCursor, isActive, permissions }: {
  rows: readonly SalesDesignation[];
  failed?: string | undefined;
  nextCursor?: string | undefined;
  isActive?: string | undefined;
  permissions: readonly string[];
}) {
  const manage = canManage(permissions);
  const reason = useReason(manage);
  const toast = useToast();
  const url = useUrl();
  const once = useOnce();
  const [editing, setEditing] = useState<SalesDesignation | 'new' | null>(null);
  const [notice, setNotice] = useState<string>();

  const done = (msg: string) => { setEditing(null); setNotice(undefined); toast.show({ tone: 'success', title: msg }); url.refresh(); };
  const toggle = (d: SalesDesignation) => once(async () => {
    const r = await updateDesignationAction(d.id, d.version, { is_active: !d.is_active });
    if (r.ok) done(t(d.is_active ? 'partners.sales.deactivated' : 'partners.sales.activated'));
    else setNotice(failure(r, []).text);
  });

  const columns: Col<SalesDesignation>[] = [
    { id: 'level', header: t('partners.sales.col.level'), numeric: true, cell: (d) => String(d.level) },
    { id: 'name', header: t('partners.sales.col.name'), cell: (d) => d.name },
    { id: 'active', header: t('partners.sales.col.active'), cell: (d) => yesNo(d.is_active) },
    {
      id: 'actions', header: t('partners.sales.col.actions'),
      cell: (d) => (
        <span className="lims-inline">
          <Gated size="sm" variant="ghost" reasonId={reason.id} onPress={() => setEditing(d)}>{t('partners.sales.edit')}</Gated>
          <Gated size="sm" variant="ghost" reasonId={reason.id} onPress={() => void toggle(d)}>{t(d.is_active ? 'partners.sales.deactivate' : 'partners.sales.activate')}</Gated>
        </span>
      ),
    },
  ];

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.sales_designations')} helpKey="partners.sales.designations"
        actions={<Gated variant="primary" reasonId={reason.id} onPress={() => setEditing('new')}>{t('partners.sales.designations.add')}</Gated>} />
      {reason.line}
      <StatusFilter value={isActive} />
      <Alert text={notice} />
      <SalesTable caption={t('partners.nav.sales_designations')} columns={columns} rows={rows} getRowId={(d) => d.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('partners.sales.designations.empty'), body: t('partners.sales.designations.empty_hint') }} />
      {editing ? <DesignationDialog row={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDone={() => done(t('partners.sales.saved'))} /> : null}
    </section>
  );
}

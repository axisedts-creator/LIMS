'use client';
// T0D-SALES-1 (LD-321, LD-353 template 1 LIST): ElabAssist Services In Area. Columns Name, District, Area, Centre, Active. Areas are free text district and
// area, not pincodes (LD-321). No centre = the area applies to all centres. The contract has no Activate: a deactivated area stays inactive.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { NamedOption, ServiceArea } from '../server/sales.server';
import { createServiceAreaAction, deactivateServiceAreaAction, updateServiceAreaAction } from '../server/salesActions';
import { Alert, ConfirmWrite, Gated, NONE, SalesTable, StatusFilter, canManage, failure, newKey, useOnce, useReason, useUrl, yesNo, type Col } from './SalesCommon';

const FIELDS = ['name', 'district', 'area_text', 'centre_id'] as const;
const MAX: Record<string, number> = { name: 200, district: 100, area_text: 500 };

function AreaDialog({ row, centres, onClose, onDone }: { row?: ServiceArea | undefined; centres: readonly NamedOption[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Record<(typeof FIELDS)[number], string>>({ name: row?.name ?? '', district: row?.district ?? '', area_text: row?.area_text ?? '', centre_id: row?.centre_id ?? NONE });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const once = useOnce();
  const [key] = useState(newKey);
  const set = (k: (typeof FIELDS)[number]) => (x: string) => setV((o) => ({ ...o, [k]: x }));
  const options = [{ value: NONE, label: t('partners.sales.all_centres') }, ...centres.map((c) => ({ value: c.id, label: c.name }))];

  const save = () => once(async () => {
    const val = { name: v.name.trim(), district: v.district.trim(), area_text: v.area_text.trim(), centre_id: v.centre_id === NONE ? '' : v.centre_id };
    const e: Record<string, string> = {};
    if (!val.name) e['name'] = t('partners.sales.error.name');
    if (!val.district) e['district'] = t('partners.sales.error.required');
    for (const [k, max] of Object.entries(MAX)) if (val[k as keyof typeof val].length > max) e[k] = t('partners.sales.error.too_long');
    setErrors(e);
    setText(undefined);
    if (Object.keys(e).length) return;
    let body: Record<string, unknown>;
    if (row) {
      const was: Record<string, string> = { name: row.name, district: row.district, area_text: row.area_text ?? '', centre_id: row.centre_id ?? '' };
      body = {};
      const unset: string[] = [];
      for (const k of FIELDS) {
        if (val[k] === was[k]) continue;
        if (val[k] === '') unset.push(k); // only area_text and centre_id can be empty here
        else body[k] = val[k];
      }
      if (unset.length) body['unset'] = unset;
      if (Object.keys(body).length === 0) return onClose();
    } else {
      body = Object.fromEntries(FIELDS.filter((k) => val[k] !== '').map((k) => [k, val[k]]));
    }
    setBusy(true);
    try {
      const r = row ? await updateServiceAreaAction(row.id, row.version, body) : await createServiceAreaAction(body, key);
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
    <Dialog title={t(row ? 'partners.sales.areas.edit_title' : 'partners.sales.areas.add')} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.sales.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.sales.save')}</Button></>}>
      <div className="lims-stack">
        <TextField label={t('partners.sales.field.name')} name="name" maxLength={200} isRequired value={v.name} onChange={set('name')} {...err('name')} />
        <TextField label={t('partners.sales.field.district')} name="district" maxLength={100} isRequired value={v.district} onChange={set('district')} {...err('district')} />
        <TextField label={t('partners.sales.field.area')} name="area_text" maxLength={500} description={t('partners.sales.areas.area_hint')} value={v.area_text} onChange={set('area_text')} {...err('area_text')} />
        <Select label={t('partners.sales.field.centre')} name="centre_id" options={options} value={v.centre_id} onChange={set('centre_id')} {...err('centre_id')} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export function SalesAreas({ rows, centres, failed, nextCursor, isActive, permissions }: {
  rows: readonly ServiceArea[];
  centres: readonly NamedOption[];
  failed?: string | undefined;
  nextCursor?: string | undefined;
  isActive?: string | undefined;
  permissions: readonly string[];
}) {
  const manage = canManage(permissions);
  const reason = useReason(manage);
  const toast = useToast();
  const url = useUrl();
  const [editing, setEditing] = useState<ServiceArea | 'new' | null>(null);
  const [leaving, setLeaving] = useState<ServiceArea | null>(null);
  const centre = new Map(centres.map((c) => [c.id, c.name]));

  const done = (msg: string) => { setEditing(null); setLeaving(null); toast.show({ tone: 'success', title: msg }); url.refresh(); };
  const columns: Col<ServiceArea>[] = [
    { id: 'name', header: t('partners.sales.col.name'), isRowHeader: true, cell: (a) => a.name },
    { id: 'district', header: t('partners.sales.col.district'), cell: (a) => a.district },
    { id: 'area', header: t('partners.sales.col.area'), cell: (a) => a.area_text ?? '—' },
    { id: 'centre', header: t('partners.sales.col.centre'), cell: (a) => (a.centre_id ? centre.get(a.centre_id) ?? '—' : t('partners.sales.all_centres')) },
    { id: 'active', header: t('partners.sales.col.active'), cell: (a) => yesNo(a.is_active) },
    {
      id: 'actions', header: t('partners.sales.col.actions'),
      cell: (a) => (
        <span className="lims-inline">
          <Gated size="sm" variant="ghost" reasonId={reason.id} onPress={() => setEditing(a)}>{t('partners.sales.edit')}</Gated>
          {a.is_active ? <Gated size="sm" variant="ghost" reasonId={reason.id} onPress={() => setLeaving(a)}>{t('partners.sales.deactivate')}</Gated> : null}
        </span>
      ),
    },
  ];

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.sales_areas')} helpKey="partners.sales.areas"
        actions={<Gated variant="primary" reasonId={reason.id} onPress={() => setEditing('new')}>{t('partners.sales.areas.add')}</Gated>} />
      {reason.line}
      <StatusFilter value={isActive} />
      <SalesTable caption={t('partners.nav.sales_areas')} columns={columns} rows={rows} getRowId={(a) => a.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('partners.sales.areas.empty'), body: t('partners.sales.areas.empty_hint') }} />
      {editing ? <AreaDialog row={editing === 'new' ? undefined : editing} centres={centres} onClose={() => setEditing(null)} onDone={() => done(t('partners.sales.saved'))} /> : null}
      {leaving ? (
        <ConfirmWrite title={`${t('partners.sales.areas.deactivate_title')}: ${leaving.name}`} body={t('partners.sales.areas.deactivate_body')} confirm={t('partners.sales.deactivate')}
          act={() => deactivateServiceAreaAction(leaving.id, leaving.version)} onClose={() => setLeaving(null)} onDone={() => done(t('partners.sales.deactivated'))} />
      ) : null}
    </section>
  );
}

'use client';
// T0D-PARTYSET-1 (LD-321, LD-353 template 1 LIST): ElabAssist ICD master (catalog.yaml listIcdMasterCodes and its writes, catalog.icd.manage). Columns
// Code, Title, Chapter, Active; search by code prefix or title (?q), paged (Next follows next_cursor). A code is never renamed: add a new code and
// deactivate the old one. The contract cannot clear a chapter (no unset), so a chapter can be changed but not emptied. Separate from the frontdesk ICD pick list.
import { useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { SearchBar, yesNo } from '@/features/partners/components/PartysetCommon';
import { Alert, ConfirmWrite, SalesTable, failure, newKey, useOnce, useUrl, type Col } from '@/features/partners/components/SalesCommon';
import type { IcdMasterCode } from '@/features/partners/server/partyset.server';
import { createIcdCodeAction, deactivateIcdCodeAction, updateIcdCodeAction } from '@/features/partners/server/partysetActions';

const FIELDS = ['code', 'title', 'chapter'] as const;
const CODE = /^[0-9A-Z][0-9A-Z.]{0,15}$/;

function IcdDialog({ row, onClose, onDone }: { row?: IcdMasterCode | undefined; onClose: () => void; onDone: () => void }) {
  const url = useUrl();
  const [code, setCode] = useState(row?.code ?? '');
  const [title, setTitle] = useState(row?.title ?? '');
  const [chapter, setChapter] = useState(row?.chapter ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const once = useOnce();

  const save = () => once(async () => {
    const v = { code: code.trim(), title: title.trim(), chapter: chapter.trim() };
    const e: Record<string, string> = {};
    if (!row && !CODE.test(v.code)) e['code'] = t('catalog.icd.error.code');
    if (!v.title || v.title.length > 500) e['title'] = t('catalog.icd.error.title');
    if (v.chapter.length > 120 || (row?.chapter && !v.chapter)) e['chapter'] = t('catalog.icd.error.chapter');
    setErrors(e);
    setConflict(false);
    setText(Object.keys(e).length ? t('partners.partyset.check') : undefined);
    if (Object.keys(e).length) return;
    let r;
    if (row) {
      const body: Record<string, unknown> = {};
      if (v.title !== row.title) body['title'] = v.title;
      if (v.chapter && v.chapter !== (row.chapter ?? '')) body['chapter'] = v.chapter;
      if (Object.keys(body).length === 0) { setText(t('catalog.icd.no_change')); return; }
      setBusy(true);
      try { r = await updateIcdCodeAction(row.id, row.version, body); } finally { setBusy(false); }
    } else {
      setBusy(true);
      try { r = await createIcdCodeAction({ code: v.code, title: v.title, ...(v.chapter ? { chapter: v.chapter } : {}) }, key); } finally { setBusy(false); }
    }
    if (r.ok) return onDone();
    if (r.code === 'common.version_conflict') { setConflict(true); return; }
    const f = failure(r, FIELDS);
    setErrors(f.fields);
    setText(f.text);
  });

  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  return (
    <Dialog title={t(row ? 'catalog.icd.edit_title' : 'catalog.icd.add')} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.partyset.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.penalties.save')}</Button></>}>
      <div className="lims-stack">
        {conflict ? <div role="alert"><Banner tone="warning" title={t('partners.partyset.conflict')} action={{ label: t('partners.partyset.refresh'), onPress: url.refresh }} /></div> : null}
        <TextField label={t('catalog.icd.field.code')} name="code" maxLength={32} isRequired={!row} isReadOnly={!!row} description={t('catalog.icd.code_hint')} value={code} onChange={setCode} {...err('code')} />
        <TextField label={t('catalog.icd.field.title')} name="title" maxLength={600} isRequired value={title} onChange={setTitle} {...err('title')} />
        <TextField label={t('catalog.icd.field.chapter')} name="chapter" maxLength={200} value={chapter} onChange={setChapter} {...err('chapter')} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export function IcdMaster({ rows, q, failed, nextCursor }: { rows: readonly IcdMasterCode[]; q?: string | undefined; failed?: string | undefined; nextCursor?: string | undefined }) {
  const toast = useToast();
  const url = useUrl();
  const [editing, setEditing] = useState<IcdMasterCode | 'new' | null>(null);
  const [leaving, setLeaving] = useState<IcdMasterCode | null>(null);
  const done = (msg: string) => { setEditing(null); setLeaving(null); toast.show({ tone: 'success', title: msg }); url.refresh(); };

  const columns: Col<IcdMasterCode>[] = [
    { id: 'code', header: t('catalog.icd.col.code'), isRowHeader: true, cell: (c) => <span className="lims-mono">{c.code}</span> },
    { id: 'title', header: t('catalog.icd.col.title'), cell: (c) => c.title },
    { id: 'chapter', header: t('catalog.icd.col.chapter'), cell: (c) => c.chapter ?? '—' },
    { id: 'active', header: t('catalog.icd.col.active'), cell: (c) => yesNo(c.is_active) },
    {
      id: 'actions', header: t('partners.partyset.col.actions'),
      cell: (c) => (c.is_active ? (
        <span className="lims-inline">
          <Button size="sm" variant="ghost" onPress={() => setEditing(c)}>{t('partners.penalties.edit')}</Button>
          <Button size="sm" variant="ghost" onPress={() => setLeaving(c)}>{t('partners.penalties.deactivate')}</Button>
        </span>
      ) : null),
    },
  ];

  return (
    <section className="lims-stack">
      <PageHeader title={t('catalog.nav.icd')} helpKey="catalog.icd"
        actions={<Button variant="primary" onPress={() => setEditing('new')}>{t('catalog.icd.add')}</Button>} />
      <SearchBar q={q} />
      <SalesTable caption={t('catalog.nav.icd')} columns={columns} rows={rows} getRowId={(c) => c.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('catalog.icd.empty'), body: t('catalog.icd.empty_hint') }} />
      {editing ? <IcdDialog row={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDone={() => done(t('catalog.icd.saved'))} /> : null}
      {leaving ? (
        <ConfirmWrite title={`${t('catalog.icd.deactivate_title')}: ${leaving.code}`} body={t('catalog.icd.deactivate_body')} confirm={t('partners.penalties.deactivate')}
          act={() => deactivateIcdCodeAction(leaving.id, leaving.version)} onClose={() => setLeaving(null)} onDone={() => done(t('catalog.icd.deactivated'))} />
      ) : null}
    </section>
  );
}

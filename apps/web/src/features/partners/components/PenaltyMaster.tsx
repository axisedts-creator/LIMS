'use client';
// T0D-PARTYSET-1 (LD-321, LD-353 template 1 LIST): ElabAssist Non Compliance penalty list. Columns Code, Name, Amount (rupees from integer paisa), Active.
// Add (code, name, amount), Edit (name and amount; the code never changes) and Deactivate (events already raised keep the penalty). Inactive rows are final.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { NonCompliancePenalty } from '../server/partyset.server';
import { createPenaltyAction, deactivatePenaltyAction, updatePenaltyAction } from '../server/partysetActions';
import { SearchBar, hundredths, parsePaisa, rupees, yesNo } from './PartysetCommon';
import { Alert, ConfirmWrite, SalesTable, failure, newKey, useOnce, useUrl, type Col } from './SalesCommon';

const FIELDS = ['code', 'name', 'amount_paisa'] as const;
const CODE = /^[A-Z0-9_-]{1,20}$/;

function PenaltyDialog({ row, onClose, onDone }: { row?: NonCompliancePenalty | undefined; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [amount, setAmount] = useState(row ? hundredths(row.amount_paisa) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const once = useOnce();

  const save = () => once(async () => {
    const e: Record<string, string> = {};
    const paisa = parsePaisa(amount);
    if (!row && !CODE.test(code.trim())) e['code'] = t('partners.partyset.error.code');
    if (!name.trim() || name.trim().length > 120) e['name'] = t('partners.partyset.error.name');
    if (paisa === undefined) e['amount_paisa'] = t('partners.partyset.error.amount');
    setErrors(e);
    setText(Object.keys(e).length ? t('partners.partyset.check') : undefined);
    if (Object.keys(e).length || paisa === undefined) return;
    let r;
    if (row) {
      const body: Record<string, unknown> = {};
      if (name.trim() !== row.name) body['name'] = name.trim();
      if (paisa !== row.amount_paisa) body['amount_paisa'] = paisa;
      if (Object.keys(body).length === 0) return onClose();
      setBusy(true);
      try { r = await updatePenaltyAction(row.id, row.version, body); } finally { setBusy(false); }
    } else {
      setBusy(true);
      try { r = await createPenaltyAction({ code: code.trim(), name: name.trim(), amount_paisa: paisa }, key); } finally { setBusy(false); }
    }
    if (r.ok) return onDone();
    const f = failure(r, FIELDS);
    setErrors(f.fields);
    setText(f.text);
  });

  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  return (
    <Dialog title={t(row ? 'partners.penalties.edit_title' : 'partners.penalties.add')} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.partyset.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.penalties.save')}</Button></>}>
      <div className="lims-stack">
        <TextField label={t('partners.penalties.field.code')} name="code" maxLength={40} isRequired={!row} isReadOnly={!!row} description={t('partners.penalties.code_hint')} value={code} onChange={setCode} {...err('code')} />
        <TextField label={t('partners.penalties.field.name')} name="name" maxLength={200} isRequired value={name} onChange={setName} {...err('name')} />
        <TextField label={t('partners.penalties.field.amount')} name="amount" maxLength={20} inputMode="decimal" isRequired value={amount} onChange={setAmount} {...err('amount_paisa')} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export function PenaltyMaster({ rows, q, failed, nextCursor }: { rows: readonly NonCompliancePenalty[]; q?: string | undefined; failed?: string | undefined; nextCursor?: string | undefined }) {
  const toast = useToast();
  const url = useUrl();
  const [editing, setEditing] = useState<NonCompliancePenalty | 'new' | null>(null);
  const [leaving, setLeaving] = useState<NonCompliancePenalty | null>(null);
  const done = (msg: string) => { setEditing(null); setLeaving(null); toast.show({ tone: 'success', title: msg }); url.refresh(); };

  const columns: Col<NonCompliancePenalty>[] = [
    { id: 'code', header: t('partners.penalties.col.code'), isRowHeader: true, cell: (p) => <span className="lims-mono">{p.code}</span> },
    { id: 'name', header: t('partners.penalties.col.name'), cell: (p) => p.name },
    { id: 'amount', header: t('partners.penalties.col.amount'), align: 'end', cell: (p) => rupees(p.amount_paisa) },
    { id: 'active', header: t('partners.penalties.col.active'), cell: (p) => yesNo(p.is_active) },
    {
      id: 'actions', header: t('partners.partyset.col.actions'),
      cell: (p) => (p.is_active ? (
        <span className="lims-inline">
          <Button size="sm" variant="ghost" onPress={() => setEditing(p)}>{t('partners.penalties.edit')}</Button>
          <Button size="sm" variant="ghost" onPress={() => setLeaving(p)}>{t('partners.penalties.deactivate')}</Button>
        </span>
      ) : null),
    },
  ];

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.penalties')} helpKey="partners.penalties"
        actions={<Button variant="primary" onPress={() => setEditing('new')}>{t('partners.penalties.add')}</Button>} />
      <SearchBar q={q} />
      <SalesTable caption={t('partners.nav.penalties')} columns={columns} rows={rows} getRowId={(p) => p.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('partners.penalties.empty'), body: t('partners.penalties.empty_hint') }} />
      {editing ? <PenaltyDialog row={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDone={() => done(t('partners.penalties.saved'))} /> : null}
      {leaving ? (
        <ConfirmWrite title={`${t('partners.penalties.deactivate_title')}: ${leaving.name}`} body={t('partners.penalties.deactivate_body')} confirm={t('partners.penalties.deactivate')}
          act={() => deactivatePenaltyAction(leaving.id, leaving.version)} onClose={() => setLeaving(null)} onDone={() => done(t('partners.penalties.deactivated'))} />
      ) : null}
    </section>
  );
}

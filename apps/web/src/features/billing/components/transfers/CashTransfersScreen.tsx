'use client';
// T0D-ACCT-2 (LD-313, LD-310): billing/cash-transfers = ElabAssist Cash Transfer (All Transfers; Search, Accept, Reject) with tabs All, Sent, Received,
// Pending, New transfer, and Cancel for the sender while pending. Accept posts a balanced pair server side in one transaction (LD-313 b); no money
// moves, it only records. Both pocket balances are shown before the user confirms; the balance warning does not block (the API refuses an overdraw).
// Accept, reject and cancel carry no body (the contract has none): the transfer's own remark is shown, never invented.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { createCashTransferAction, decideCashTransferAction, getPocketBalanceAction } from '../../server/expenses.actions';
import type { CashTransfer, PocketBalance, TransferKind } from '../../server/expenses.server';
import type { Named } from '../../server/accounts.server';
import { errorText, formatNpr, hasPerm } from '../format';
import { GatedButton, LabelOnlySelect, nameOf, newKey, toPaisa } from '../accounts/accountsShared';

const X = (k: string) => t(`billing.transfers.${k}`);
const MANAGE = 'billing.cash_transfer.manage';
const DECIDE = 'billing.cash_transfer.decide';
const TABS = ['all', 'sent', 'received', 'pending'] as const;
type Tab = (typeof TABS)[number];
type Action = 'accept' | 'reject' | 'cancel';

export interface CashTransfersScreenProps {
  transfers: readonly CashTransfer[];
  centres: readonly Named[];
  members: readonly Named[];
  /** Membership id of the signed in user (session actor, LD-89). */
  currentMembershipId: string;
  /** Centres whose pocket the signed in user may receive into. */
  currentCentreIds: readonly string[];
  tab: Tab;
  permissions: readonly string[];
  filters?: { from_id?: string; to_id?: string };
}

/** Cash held in a pocket: a credit side balance is cash held, a debit side one is owed. */
const held = (b: PocketBalance) => (b.side === 'credit' ? b.paisa : -b.paisa);

export function CashTransfersScreen({ transfers, centres, members, currentMembershipId: me, currentCentreIds, tab, permissions, filters = {} }: CashTransfersScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [f, setF] = useState(filters);
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<{ row: CashTransfer; action: Action } | null>(null);
  const canManage = hasPerm(permissions, MANAGE);
  const canDecide = hasPerm(permissions, DECIDE);
  const name = (kind: TransferKind, id: string) => nameOf(kind === 'centre' ? centres : members, id);
  const isReceiver = (r: CashTransfer) => (r.to_kind === 'user' ? !!me && r.to_id === me : currentCentreIds.includes(r.to_id));
  const block = (r: CashTransfer, a: Action): string | undefined => {
    if (a === 'cancel') return !canManage ? X('reason.no_manage') : r.status !== 'pending' ? X('reason.not_pending') : r.created_by !== me ? X('reason.not_creator') : undefined;
    return r.status !== 'pending' ? X('reason.not_pending') : !canDecide ? X('reason.no_decide') : r.created_by === me ? X('reason.own_transfer') : !isReceiver(r) ? X('reason.not_receiver') : undefined;
  };
  const go = (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
    router.push(`${pathname}?${p}`);
  };

  const columns: ColumnDef<CashTransfer>[] = [
    { id: 'date', header: X('col.date'), cell: (r) => <DateText value={r.created_at as never} mode="AD_BS" withTime /> },
    { id: 'from', header: X('col.from'), cell: (r) => name(r.from_kind, r.from_id) },
    { id: 'to', header: X('col.to'), cell: (r) => name(r.to_kind, r.to_id) },
    { id: 'amount', header: X('col.amount'), align: 'end', cell: (r) => formatNpr(r.amount_paisa) },
    { id: 'status', header: X('col.status'), cell: (r) => X(`status.${r.status}`) },
    { id: 'remark', header: X('col.remark'), isRowHeader: true, cell: (r) => r.remark ?? '' },
    {
      id: 'action',
      header: X('col.action'),
      cell: (r) => (
        <span className="lims-inline">
          {(['accept', 'reject', 'cancel'] as const).map((a) => <GatedButton key={a} label={X(a)} blocked={block(r, a)} variant={a === 'accept' ? 'primary' : 'secondary'} onPress={() => setDeciding({ row: r, action: a })} />)}
        </span>
      ),
    },
  ];
  const parties = [...members.map((m) => ({ value: m.id, label: m.name })), ...centres.map((c) => ({ value: c.id, label: c.name }))];

  return (
    <section aria-label={X('title')}>
      <PageHeader title={t('nav.billing.cash_transfers')} helpKey="billing.accounts" actions={<GatedButton variant="primary" label={X('new')} blocked={canManage ? undefined : X('reason.no_manage')} onPress={() => setCreating(true)} />} />
      {/* T0D-UIGUARD-1-BILLING (LD-353 rule 2): the kit FilterBar holds the row; From, To and Search stay as they were. */}
      <FilterBar aria-label={X('filters')}>
        <Select label={X('col.from')} name="from_id" options={parties} {...(f.from_id ? { value: f.from_id } : {})} onChange={(v) => setF({ ...f, from_id: v })} />
        <Select label={X('col.to')} name="to_id" options={parties} {...(f.to_id ? { value: f.to_id } : {})} onChange={(v) => setF({ ...f, to_id: v })} />
        <Button variant="primary" onPress={() => go({ tab, ...f })}>{X('search')}</Button>
      </FilterBar>
      <Tabs aria-label={X('title')} items={TABS.map((id) => ({ id, label: X(`tab.${id}`) }))} selectedId={tab} onChange={(id) => go({ tab: id })}>
        <DataTable caption={X(`tab.${tab}`)} density="compact" columns={columns} rows={transfers} getRowId={(r) => r.id} emptyState={{ title: X('empty') }} />
      </Tabs>
      {creating ? (
        <TransferDialog
          parties={[...members.map((m) => ({ value: `user:${m.id}`, label: m.name })), ...centres.map((c) => ({ value: `centre:${c.id}`, label: c.name }))]}
          onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); toast.show({ tone: 'success', title: X('saved') }); router.refresh(); }}
          onFail={(code) => toast.show({ tone: 'danger', title: X('failed'), description: errorText(code) })}
        />
      ) : null}
      {deciding ? (
        <DecideDialog
          {...deciding}
          fromName={name(deciding.row.from_kind, deciding.row.from_id)}
          toName={name(deciding.row.to_kind, deciding.row.to_id)}
          onClose={() => setDeciding(null)}
          onDone={() => { setDeciding(null); toast.show({ tone: 'success', title: X(`done.${deciding.action}`) }); router.refresh(); }}
          onFail={(code) => toast.show({ tone: 'danger', title: X('failed'), description: errorText(code) })}
        />
      ) : null}
    </section>
  );
}

/** Reads one pocket; undefined while loading, null when it could not be read. */
function usePocket(partyId: string | undefined): PocketBalance | null | undefined {
  const [b, setB] = useState<PocketBalance | null | undefined>();
  useEffect(() => {
    setB(undefined);
    if (!partyId) return;
    let live = true;
    void getPocketBalanceAction(partyId).then((r) => { if (live) setB(r.ok ? r.data : null); });
    return () => { live = false; };
  }, [partyId]);
  return b;
}
const balanceText = (b: PocketBalance | null | undefined) => (b === undefined ? '…' : b === null ? X('balance_unavailable') : formatNpr(held(b)));

function Balances({ fromId, toId, amount }: { fromId: string | undefined; toId: string | undefined; amount: number | undefined }) {
  const from = usePocket(fromId);
  const to = usePocket(toId);
  if (!fromId && !toId) return null;
  const short = !!from && amount !== undefined && amount > held(from);
  return (
    <div className="lims-stack">
      <dl className="lims-inline">
        {fromId ? <><dt>{X('balance_sender')}</dt><dd>{balanceText(from)}</dd></> : null}
        {toId ? <><dt>{X('balance_receiver')}</dt><dd>{balanceText(to)}</dd></> : null}
      </dl>
      {short ? <p role="status" className="lims-warning">{X('balance_warning')}</p> : null}
    </div>
  );
}

type Done = { onClose: () => void; onDone: () => void; onFail: (code: string) => void };

function DecideDialog({ row, action, fromName, toName, onClose, onDone, onFail }: { row: CashTransfer; action: Action; fromName: string; toName: string } & Done) {
  const key = useRef(newKey());
  const confirm = async () => {
    const r = await decideCashTransferAction(row.id, action, key.current);
    if (r.ok) onDone();
    else { key.current = newKey(); onFail(r.code); }
  };
  return (
    <ConfirmDialog
      title={X(`${action}_title`)}
      confirmLabel={X(`${action}_confirm`)}
      tone={action === 'accept' ? 'default' : 'danger'}
      isOpen
      onCancel={onClose}
      onConfirm={confirm}
      body={(
        <>
          <dl className="lims-inline">
            <dt>{X('col.from')}</dt><dd>{fromName}</dd>
            <dt>{X('col.to')}</dt><dd>{toName}</dd>
            <dt>{X('col.amount')}</dt><dd>{formatNpr(row.amount_paisa)}</dd>
            {row.remark ? <><dt>{X('col.remark')}</dt><dd>{row.remark}</dd></> : null}
          </dl>
          {action === 'accept' ? <Balances fromId={row.from_id} toId={row.to_id} amount={row.amount_paisa} /> : null}
        </>
      )}
    />
  );
}

function TransferDialog({ parties, onClose, onDone, onFail }: { parties: readonly { value: string; label: string }[] } & Done) {
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'from' | 'to' | 'amount' | 'remark', string>>>({});
  const [pending, setPending] = useState(false);
  const key = useRef(newKey());
  const split = (v: string | undefined) => (v ? (v.split(':') as [TransferKind, string]) : undefined);
  const paisa = toPaisa(amount);
  const submit = async () => {
    const req = t('billing.accounts.error.required');
    const e: typeof errors = {};
    if (!from) e.from = req;
    if (!to) e.to = req;
    if (from && to && split(from)![1] === split(to)![1]) e.to = X('same_party');
    if (paisa === undefined) e.amount = t('billing.accounts.error.amount');
    if (remark.length > 1000) e.remark = X('error.remark');
    setErrors(e);
    if (Object.keys(e).length) return;
    const [fk, fid] = split(from)!;
    const [tk, tid] = split(to)!;
    setPending(true);
    const r = await createCashTransferAction({ from_kind: fk, from_id: fid, to_kind: tk, to_id: tid, amount_paisa: paisa!, ...(remark.trim() ? { remark: remark.trim() } : {}) }, key.current);
    setPending(false);
    if (r.ok) onDone();
    else { key.current = newKey(); onFail(r.code); }
  };
  return (
    <Dialog title={X('form_title')} isOpen onClose={onClose} size="md">
      <Form onSubmit={submit} errorSummary={false}>
        <LabelOnlySelect label={X('col.from')} value={from} options={parties} onChange={setFrom} error={errors.from} />
        <LabelOnlySelect label={X('col.to')} value={to} options={parties} onChange={setTo} error={errors.to} />
        <TextField label={X('col.amount')} name="amount" inputMode="decimal" maxLength={17} value={amount} onChange={setAmount} {...(errors.amount ? { error: errors.amount } : {})} />
        <TextArea label={X('col.remark')} name="remark" maxLength={2000} value={remark} onChange={setRemark} {...(errors.remark ? { error: errors.remark } : {})} />
        <Balances fromId={split(from)?.[1]} toId={split(to)?.[1]} amount={paisa} />
        <div className="lims-inline">
          <Button type="submit" variant="primary" isLoading={pending} shortcut="Ctrl+Enter">{X('submit')}</Button>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>{X('form_cancel')}</Button>
        </div>
      </Form>
    </Dialog>
  );
}

'use client';
// T0D-ACCT-1 (LD-313): billing/accounts/masters = account groups and particulars: create, rename, deactivate / activate (never delete).
// Code, nature and group are immutable after create (contract): the edit dialog shows code read only and sends name only, with If-Match.
// The lab accountant confirms the groups and particulars before go-live (LD-313 e).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Button } from '@lims/ui/components/Button';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { createAccountGroupAction, createAccountParticularAction, updateAccountMasterAction } from '../../server/accounts.actions';
import type { AccountGroup, AccountParticular, GroupNature } from '../../server/accounts.server';
import { errorText, hasPerm } from '../format';
import { GatedButton, PERM, nameOf, newKey } from './accountsShared';

const NATURES: readonly GroupNature[] = ['income', 'expense', 'asset', 'liability'];
const CODE_RE = /^[A-Z0-9_]{1,32}$/;
const REASON_ID = 'acct-masters-reason';

type Kind = 'group' | 'particular';
type Editing = { kind: Kind; row?: AccountGroup | AccountParticular };

export interface AccountMastersScreenProps { groups: readonly AccountGroup[]; particulars: readonly AccountParticular[]; permissions: readonly string[] }

export function AccountMastersScreen({ groups, particulars, permissions }: AccountMastersScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<Editing | null>(null);
  const canManage = hasPerm(permissions, PERM.manage);
  const blocked = canManage ? undefined : t('billing.accounts.reason.no_manage');
  const done = () => { setEditing(null); toast.show({ tone: 'success', title: t('billing.accounts.masters.saved') }); router.refresh(); };
  const fail = (code: string) => toast.show({ tone: 'danger', title: t('billing.accounts.masters.failed'), description: errorText(code) });
  const toggle = async (kind: Kind, row: AccountGroup | AccountParticular) => {
    const r = await updateAccountMasterAction(kind, row.id, row.version, { is_active: !row.is_active }, newKey());
    if (r.ok) done(); else fail(r.code);
  };
  const state = (r: { is_active: boolean }) => t(r.is_active ? 'billing.accounts.masters.active' : 'billing.accounts.masters.inactive');
  const actions = (kind: Kind) => (r: AccountGroup | AccountParticular) => (
    <span className="lims-inline">
      <GatedButton label={t('billing.accounts.masters.edit')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({ kind, row: r })} />
      <GatedButton label={t(r.is_active ? 'billing.accounts.masters.deactivate' : 'billing.accounts.masters.activate')} blocked={blocked} reasonId={REASON_ID} onPress={() => void toggle(kind, r)} />
    </span>
  );
  const groupColumns: ColumnDef<AccountGroup>[] = [
    { id: 'code', header: t('billing.accounts.col.code'), isRowHeader: true, cell: (g) => g.code },
    { id: 'name', header: t('billing.accounts.col.name'), cell: (g) => g.name },
    { id: 'nature', header: t('billing.accounts.col.nature'), cell: (g) => t(`billing.accounts.nature.${g.nature}`) },
    { id: 'state', header: t('billing.accounts.col.state'), cell: state },
    { id: 'actions', header: t('billing.accounts.col.actions'), cell: actions('group') },
  ];
  const particularColumns: ColumnDef<AccountParticular>[] = [
    { id: 'group', header: t('billing.accounts.col.group'), cell: (p) => nameOf(groups, p.account_group_id) },
    { id: 'code', header: t('billing.accounts.col.code'), isRowHeader: true, cell: (p) => p.code },
    { id: 'name', header: t('billing.accounts.col.name'), cell: (p) => p.name },
    { id: 'state', header: t('billing.accounts.col.state'), cell: state },
    { id: 'actions', header: t('billing.accounts.col.actions'), cell: actions('particular') },
  ];
  return (
    <section aria-label={t('billing.accounts.masters.title')}>
      <PageHeader title={t('billing.accounts.masters.title')} helpKey="billing.accounts" />
      {blocked ? <p id={REASON_ID} className="lims-description">{blocked}</p> : null}
      {/* T0D-UIGUARD-1-BILLING (LD-436 R7, LD-439): each master list is a Card with its title row, not a raw h2. */}
      <Card title={t('billing.accounts.masters.groups')}>
        <GatedButton variant="primary" label={t('billing.accounts.masters.new_group')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({ kind: 'group' })} />
        <DataTable caption={t('billing.accounts.masters.groups')} density="compact" columns={groupColumns} rows={groups} getRowId={(g) => g.id} emptyState={{ title: t('billing.accounts.masters.empty_groups') }} />
      </Card>
      <Card title={t('billing.accounts.masters.particulars')}>
        <GatedButton variant="primary" label={t('billing.accounts.masters.new_particular')} blocked={blocked} reasonId={REASON_ID} onPress={() => setEditing({ kind: 'particular' })} />
        <DataTable caption={t('billing.accounts.masters.particulars')} density="compact" columns={particularColumns} rows={particulars} getRowId={(p) => p.id} emptyState={{ title: t('billing.accounts.masters.empty_particulars') }} />
      </Card>
      {editing ? <MasterDialog editing={editing} groups={groups.filter((g) => g.is_active)} onClose={() => setEditing(null)} onDone={done} onFail={fail} /> : null}
    </section>
  );
}

function MasterDialog({ editing, groups, onClose, onDone, onFail }: { editing: Editing; groups: readonly AccountGroup[]; onClose: () => void; onDone: () => void; onFail: (code: string) => void }) {
  const { kind, row } = editing;
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [nature, setNature] = useState<GroupNature>();
  const [groupId, setGroupId] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = useRef(newKey());
  const title = t(row ? `billing.accounts.masters.edit_${kind}` : `billing.accounts.masters.new_${kind}`);
  const submit = async () => {
    const e: Record<string, string> = {};
    const req = t('billing.accounts.error.required');
    if (!row && !CODE_RE.test(code)) e['code'] = t('billing.accounts.error.code');
    if (!name.trim()) e['name'] = req;
    if (!row && kind === 'group' && !nature) e['nature'] = req;
    if (!row && kind === 'particular' && !groupId) e['group'] = req;
    setErrors(e);
    if (Object.keys(e).length) return;
    const r = row
      ? await updateAccountMasterAction(kind, row.id, row.version, { name: name.trim() }, key.current)
      : kind === 'group'
        ? await createAccountGroupAction({ code, name: name.trim(), nature: nature! }, key.current)
        : await createAccountParticularAction({ account_group_id: groupId!, code, name: name.trim() }, key.current);
    if (r.ok) onDone();
    else { key.current = newKey(); onFail(r.code); }
  };
  const err = (k: string) => (errors[k] ? { error: errors[k]! } : {});
  return (
    <Dialog title={title} isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit} errorSummary={false}>
        {kind === 'particular' && !row ? <Select label={t('billing.accounts.field.group')} name="account_group_id" options={groups.map((g) => ({ value: g.id, label: g.name }))} {...(groupId ? { value: groupId } : {})} onChange={setGroupId} {...err('group')} /> : null}
        <TextField label={t('billing.accounts.field.code')} name="code" maxLength={32} value={code} isReadOnly={!!row} onChange={(v) => setCode(v.toUpperCase())} {...err('code')} />
        <TextField label={t('billing.accounts.field.name')} name="name" maxLength={200} value={name} onChange={setName} {...err('name')} />
        {kind === 'group' && !row ? <Select label={t('billing.accounts.field.nature')} name="nature" options={NATURES.map((n) => ({ value: n, label: t(`billing.accounts.nature.${n}`) }))} {...(nature ? { value: nature } : {})} onChange={setNature} {...err('nature')} /> : null}
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">{t('billing.accounts.masters.save')}</Button>
      </Form>
    </Dialog>
  );
}

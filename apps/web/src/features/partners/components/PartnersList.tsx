'use client';
// SP-1 Partners (04-UI-UX §4, US-01.1-.6): list + filters in the URL + "New partner" dialog (SA2). Credit party is looked up by code prefix through C3 (max 20 characters).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createPartnerAction, searchCreditPartiesAction } from '../server/actions';
import type { Branch, Centre, CreditPartyHit, PartnerSummary } from '../server/types';
import { Chip, DialogError, LoadFailed, errorText, useUrlFilters } from './common';

const CODE_RE = /^[A-Z0-9_-]{1,20}$/;
const MODES = [{ value: 'on_receipt', label: 'When the lab receives the samples' }, { value: 'on_submit', label: 'As soon as the partner submits' }] as const;
const partyLabel = (p: CreditPartyHit) => `${p.party_code} · ${p.name}`;

function NewPartnerDialog({ branches, centres, onClose }: { branches: readonly Branch[]; centres: readonly Centre[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [party, setParty] = useState<CreditPartyHit>();
  const [branchId, setBranchId] = useState<string>();
  const [centreId, setCentreId] = useState<string>();
  const [mode, setMode] = useState<(typeof MODES)[number]['value']>('on_receipt');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const centreOptions = centres.filter((c) => !branchId || !c.branch_id || c.branch_id === branchId);

  const submit = async () => {
    if (inFlight.current) return;
    if (!CODE_RE.test(code)) return setError('Partner code can use capital letters, digits, - and _ only (up to 20 characters).');
    if (!name.trim() || !party || !branchId || !centreId) return setError('Fill in the name, credit party, receiving branch and receiving centre.');
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const r = await createPartnerAction({ partner_code: code, name: name.trim(), credit_party_id: party.id, receiving_branch_id: branchId, receiving_centre_id: centreId, conversion_mode: mode }, crypto.randomUUID());
      if (!r.ok) return setError(errorText(r.code, r.status));
      toast.show({ tone: 'success', title: 'Partner created.' });
      onClose();
      const created = (r.data as { id?: string } | undefined)?.id;
      if (created) router.push(`/partners/${created}`);
      else router.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New partner"
      isOpen
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant="primary" isLoading={busy} onPress={() => void submit()}>Create partner</Button>
        </>
      }
    >
      <TextField label="Partner code" name="partner_code" maxLength={20} isRequired value={code} onChange={(v) => setCode(v.toUpperCase())} description="Capital letters, digits, - and _" />
      <TextField label="Name" name="name" maxLength={160} isRequired value={name} onChange={setName} />
      <Combobox<CreditPartyHit>
        label="Credit party"
        name="credit_party"
        isRequired
        value={party}
        onChange={setParty}
        loadOptions={async (q) => { const r = await searchCreditPartiesAction(q); return r.ok ? r.data : []; }}
        getKey={(p) => p.id}
        renderOption={(p) => partyLabel(p)}
        renderValue={partyLabel}
      />
      <Select label="Receiving branch" name="receiving_branch_id" isRequired options={branches.map((b) => ({ value: b.id, label: b.name }))} {...(branchId ? { value: branchId } : {})} onChange={(v) => { setBranchId(v); setCentreId(undefined); }} />
      <Select key={branchId ?? 'any'} label="Receiving centre" name="receiving_centre_id" isRequired options={centreOptions.map((c) => ({ value: c.id, label: c.name }))} {...(centreId ? { value: centreId } : {})} onChange={setCentreId} />
      <RadioGroup label="Create orders" name="conversion_mode" options={MODES} value={mode} onChange={setMode} />
      <DialogError text={error} />
    </Dialog>
  );
}

export function PartnersList({ rows, failed, canManage, branches, centres, filters }: { rows: readonly PartnerSummary[]; failed: boolean; canManage: boolean; branches: readonly Branch[]; centres: readonly Centre[]; filters: { status?: string | undefined; q?: string | undefined } }) {
  const router = useRouter();
  const setUrl = useUrlFilters();
  const [creating, setCreating] = useState(false);

  const columns: ColumnDef<PartnerSummary>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => <span className="lims-mono">{p.partner_code}</span> },
    { id: 'name', header: 'Name', cell: (p) => <a className="lims-link" href={`/partners/${p.id}`}>{p.name}</a> },
    { id: 'credit', header: 'Credit party', cell: (p) => `${p.credit_party.party_code} · ${p.credit_party.name}` },
    { id: 'centre', header: 'Receiving centre', cell: (p) => p.receiving_centre.name },
    { id: 'users', header: 'Active users', align: 'end', cell: (p) => p.active_users },
    { id: 'open', header: 'Open manifests', align: 'end', cell: (p) => p.open_manifests },
    { id: 'status', header: 'Status', cell: (p) => <Chip code={p.status} /> },
  ];

  return (
    <section aria-label="Partners">
      <PageHeader title="Partners" helpKey="partners.list" actions={canManage ? <Button variant="primary" onPress={() => setCreating(true)}>New partner</Button> : null} />
      <FilterBar
        filters={[{ id: 'status', label: 'Status', kind: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }] }, { id: 'q', label: 'Search', kind: 'text', maxLength: 64 }]}
        value={{ status: filters.status, q: filters.q }}
        onChange={(v) => setUrl({ status: v['status'] as string | undefined, q: v['q'] as string | undefined })}
        onReset={() => setUrl({ status: undefined, q: undefined })}
      />
      {failed ? (
        <LoadFailed />
      ) : (
        <DataTable caption="Partners" columns={columns} rows={rows} getRowId={(p) => p.id} emptyState={{ title: 'No partners', body: 'Create a partner to start receiving their manifests.' }} onRowAction={(p) => router.push(`/partners/${p.id}`)} />
      )}
      {creating ? <NewPartnerDialog branches={branches} centres={centres} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

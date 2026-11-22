'use client';
// SCR-13 Price lists (04-UI-UX §4): list + "New price list". The owner kind ("Applies to") is a create-only choice; owners are
// assigned on the detail screen. Without catalog.price_list.manage the table is all there is (the API enforces).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { DataTable } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextField } from '@lims/ui/components/TextField';
import { createPriceListAction } from '../server/pricingActions';
import { PRICE_LIST_CODE_RE, type PriceList, type PriceOwnerKind } from '../server/types';
import { StatusBadge } from './master-ui';
import { fmtDateTime } from './shared';
import { ActionDialog, canManagePrices } from './pricing-ui';
import { t } from '@/core/i18n/messages';

export const OWNER_LABEL: Record<PriceOwnerKind, string> = { default: 'Default', credit_party: 'Hospital-company', referrer: 'Doctor', centre: 'Centre' };
const KIND_OPTIONS = (Object.keys(OWNER_LABEL) as PriceOwnerKind[]).map((value) => ({ value, label: OWNER_LABEL[value] }));

export function PriceListsList({ priceLists, permissions }: { priceLists: readonly PriceList[]; permissions: readonly string[] }) {
  const manage = canManagePrices(permissions);
  const [creating, setCreating] = useState(false);
  const open = manage ? () => setCreating(true) : undefined;
  // T0D-UILIST-3, LD-353 template 1: one FilterBar row, client side over the loaded lists [CONV].
  const [f, setF] = useState<FilterValue>({});
  const q = typeof f.q === 'string' ? f.q.trim().toLowerCase() : '';
  const shown = priceLists.filter((p) => (!q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) && (!f.owner_kind || p.owner_kind === f.owner_kind) && (!f.status || p.is_active === (f.status === 'active')));
  return (
    <section aria-label="Price lists">
      <PageHeader
        title={t('catalog.nav.price_lists')}
        helpKey="catalog.price_lists"
        actions={<>
          {/* T0D-PRICETOOLS-1: the compare view of this route (no new route); readers too */}
          <a className="lims-link" href="/catalog/price-lists?view=compare">{t('catalog.price_tools.compare_lists')}</a>
          {open ? <Button variant="primary" onPress={open}>New price list</Button> : null}
        </>}
      />
      {/* T0D-EMPTYTBL-1 (LD-310): headers always drawn; the empty message (with New price list repeated) is a body row. */}
      <FilterBar
        filters={[
          { id: 'q', kind: 'text', label: 'Search', maxLength: 100 },
          { id: 'owner_kind', kind: 'select', label: 'Applies to', options: KIND_OPTIONS },
          { id: 'status', kind: 'select', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
        ]}
        value={f}
        onChange={setF}
        onReset={() => setF({})}
      />
      <>
          {priceLists.length === 1 && priceLists[0]!.owner_kind === 'default' ? <p>Only the default price list exists.</p> : null}
          {/* T0D-UIX-2 (LD-442): the kit DataTable, header kept when empty. */}
          <DataTable<PriceList>
            caption="Price lists"
            density="regular"
            rows={shown}
            getRowId={(p) => p.id}
            cellTitle
            emptyState={priceLists.length === 0
              ? { title: 'No rate master yet — create the default price list first.', ...(open ? { action: { label: 'New price list', onPress: open } } : {}) }
              : { title: 'No price lists match the filters.' }}
            columns={[
              { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => <a className="lims-link" href={`/catalog/price-lists/${p.id}`}>{p.code}</a> },
              { id: 'name', header: 'Name', cell: (p) => p.name },
              { id: 'kind', header: 'Applies to', cell: (p) => OWNER_LABEL[p.owner_kind] },
              { id: 'assigned', header: 'Assigned to', numeric: true, cell: (p) => (p.owner_kind === 'default' ? '—' : p.assignments.length) },
              { id: 'current', header: 'Current version', cell: (p) => (p.current_version ? `v${p.current_version.version_no} · ${fmtDateTime(p.current_version.effective_from)}` : '—') },
              { id: 'scheduled', header: 'Scheduled', cell: (p) => (p.scheduled_version ? <Badge tone="info">{`Scheduled v${p.scheduled_version.version_no}`}</Badge> : '—') },
              { id: 'draft', header: 'Draft', cell: (p) => (p.draft_version_id ? <Badge tone="warning">Draft</Badge> : '—') },
              { id: 'status', header: 'Status', cell: (p) => <StatusBadge active={p.is_active} /> },
            ]}
          />
      </>
      {creating ? <NewPriceListDialog onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function NewPriceListDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PriceOwnerKind>();
  return (
    <ActionDialog
      title="New price list"
      drawer
      savedText="Price list created."
      onClose={onClose}
      run={(key) => createPriceListAction({ code: code.trim(), name: name.trim(), owner_kind: kind, assignments: [] }, key)}
      onDone={(d) => router.push(`/catalog/price-lists/${(d as { id: string }).id}`)}
    >
      <CodeField label="Code" name="code" maxLength={32} pattern={PRICE_LIST_CODE_RE.source} patternHint="Capital letters, digits, _ and -, up to 32." isRequired value={code} onChange={setCode} />
      <TextField label="Name" name="name" maxLength={120} isRequired value={name} onChange={setName} />
      <RadioGroup<PriceOwnerKind> label="Applies to" name="owner_kind" isRequired options={KIND_OPTIONS} {...(kind ? { value: kind } : {})} onChange={setKind} />
    </ActionDialog>
  );
}

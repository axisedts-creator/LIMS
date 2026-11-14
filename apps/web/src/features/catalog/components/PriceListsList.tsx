'use client';
// SCR-13 Price lists (04-UI-UX §4): list + "New price list". The owner kind ("Applies to") is a create-only choice; owners are
// assigned on the detail screen. Without catalog.price_list.manage the table is all there is (the API enforces).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextField } from '@lims/ui/components/TextField';
import { createPriceListAction } from '../server/pricingActions';
import { PRICE_LIST_CODE_RE, type PriceList, type PriceOwnerKind } from '../server/types';
import { StatusBadge } from './master-ui';
import { fmtDateTime } from './shared';
import { ActionDialog, canManagePrices } from './pricing-ui';

export const OWNER_LABEL: Record<PriceOwnerKind, string> = { default: 'Default', credit_party: 'Hospital-company', referrer: 'Doctor', centre: 'Centre' };
const KIND_OPTIONS = (Object.keys(OWNER_LABEL) as PriceOwnerKind[]).map((value) => ({ value, label: OWNER_LABEL[value] }));

export function PriceListsList({ priceLists, permissions }: { priceLists: readonly PriceList[]; permissions: readonly string[] }) {
  const manage = canManagePrices(permissions);
  const [creating, setCreating] = useState(false);
  const open = manage ? () => setCreating(true) : undefined;
  return (
    <section aria-label="Price lists">
      <PageHeader title="Price lists" helpKey="catalog.price_lists" breadcrumbs={[{ label: 'Pricing' }, { label: 'Price lists' }]} actions={open ? <Button variant="primary" onPress={open}>New price list</Button> : null} />
      {priceLists.length === 0 ? (
        <EmptyState title="No price list yet — create the default list first." />
      ) : (
        <>
          {priceLists.length === 1 && priceLists[0]!.owner_kind === 'default' ? <p>Only the default price list exists.</p> : null}
          <table className="lims-table lims-table-regular">
            <caption className="lims-visually-hidden">Price lists</caption>
            <thead>
              <tr>
                {['Code', 'Name', 'Applies to', 'Assigned to', 'Current version', 'Scheduled', 'Draft', 'Status'].map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {priceLists.map((p) => (
                <tr key={p.id} className="lims-row">
                  <td className="lims-cell"><a className="lims-link" href={`/catalog/price-lists/${p.id}`}>{p.code}</a></td>
                  <td className="lims-cell">{p.name}</td>
                  <td className="lims-cell">{OWNER_LABEL[p.owner_kind]}</td>
                  <td className="lims-cell">{p.owner_kind === 'default' ? '—' : p.assignments.length}</td>
                  <td className="lims-cell">{p.current_version ? `v${p.current_version.version_no} · ${fmtDateTime(p.current_version.effective_from)}` : '—'}</td>
                  <td className="lims-cell">{p.scheduled_version ? <Badge tone="info">{`Scheduled v${p.scheduled_version.version_no}`}</Badge> : '—'}</td>
                  <td className="lims-cell">{p.draft_version_id ? <Badge tone="warning">Draft</Badge> : '—'}</td>
                  <td className="lims-cell"><StatusBadge active={p.is_active} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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

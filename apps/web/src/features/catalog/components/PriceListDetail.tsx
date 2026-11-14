'use client';
// SCR-13 detail: General (code + "Applies to" read-only after create), Assignments (≤ 500, replaced as a whole), Versions, header
// actions. "Edit prices" opens the open draft or creates one (copy of the current version) and goes to SCR-14.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { searchDoctorsAction } from '../server/catalogActions';
import { createVersionDraftAction, replaceAssignmentsAction, searchCentresAction, searchCreditPartiesAction, updatePriceListAction } from '../server/pricingActions';
import type { PriceListDetail as Detail, PriceOwnerKind } from '../server/types';
import { SaveForm } from './master-ui';
import { FailBanner, fmtDateTime, newKey, STATUS_LABEL, STATUS_TONE, type Fail } from './shared';
import { canManagePrices } from './pricing-ui';
import { OWNER_LABEL } from './PriceListsList';

interface Owner { id: string; label: string }
const ADD_LABEL: Record<Exclude<PriceOwnerKind, 'default'>, string> = { credit_party: 'Add hospital-company', referrer: 'Add doctor', centre: 'Add centre' };
const MAX_ASSIGNMENTS = 500;

async function searchOwners(kind: PriceOwnerKind, q: string): Promise<Owner[]> {
  if (kind === 'credit_party') return searchCreditPartiesAction(q);
  if (kind === 'centre') return (await searchCentresAction(q)).map((c) => ({ id: c.centre_id, label: `${c.code} — ${c.name}` }));
  const r = await searchDoctorsAction(q);
  return r.ok ? r.data.map((d) => ({ id: d.id, label: `${d.doctor_code} — ${d.display_name}` })) : [];
}

export function PriceListDetail({ priceList, ownerLabels, permissions }: { priceList: Detail; ownerLabels: Readonly<Record<string, string>>; permissions: readonly string[] }) {
  const manage = canManagePrices(permissions);
  const router = useRouter();
  const [name, setName] = useState(priceList.name);
  const [falls, setFalls] = useState(priceList.falls_through);
  const [active, setActive] = useState(priceList.is_active);
  const [editError, setEditError] = useState<Fail>();
  const editing = useRef(false);

  const editPrices = async () => {
    if (editing.current) return;
    if (priceList.draft_version_id) return router.push(`/catalog/price-lists/${priceList.id}/versions/${priceList.draft_version_id}`);
    editing.current = true;
    try {
      const copy = priceList.current_version ? { copy_from_version_no: priceList.current_version.version_no } : {};
      const r = await createVersionDraftAction(priceList.id, copy, newKey());
      if (r.ok) router.push(`/catalog/price-lists/${priceList.id}/versions/${r.data.id}`);
      else setEditError(r);
    } finally {
      editing.current = false;
    }
  };

  const saveGeneral = () => {
    const body: Record<string, unknown> = {};
    if (name.trim() !== priceList.name) body['name'] = name.trim();
    if (falls !== priceList.falls_through) body['falls_through'] = falls;
    if (active !== priceList.is_active) body['is_active'] = active;
    return updatePriceListAction(priceList.id, priceList.version, body);
  };
  const changed = name.trim() !== priceList.name || falls !== priceList.falls_through || active !== priceList.is_active;

  const fields = (
    <>
      <TextField label="Code" name="code" isReadOnly value={priceList.code} />
      <TextField label="Name" name="name" maxLength={120} isRequired isReadOnly={!manage} value={name} onChange={setName} />
      <p>{`Applies to: ${OWNER_LABEL[priceList.owner_kind]}`}</p>
      <Switch label="Falls through" isSelected={falls} isDisabled={!manage} onChange={setFalls} />
      <p className="lims-description">When an item is missing here, use the next price list (doctor → centre → default)</p>
      <Switch label="Active" isSelected={active} isDisabled={!manage} onChange={setActive} />
    </>
  );
  return (
    <section aria-label="Price list">
      <PageHeader
        title={priceList.name}
        helpKey="catalog.price_list"
        breadcrumbs={[{ label: 'Pricing' }, { label: 'Price lists' }, { label: priceList.code }]}
        actions={
          <>
            {manage ? <Button variant="primary" onPress={editPrices}>Edit prices</Button> : null}
            <Button isDisabled>Export to Excel</Button>
            {manage ? <Button isDisabled>Import from Excel</Button> : null}
            <Button isDisabled>Compare versions</Button>
          </>
        }
      />
      {editError ? <FailBanner fail={editError} /> : null}

      <section aria-label="General">
        <h2 className="lims-section-title">General</h2>
        {manage ? <SaveForm savedText="Price list saved." keepOpen check={() => changed} save={saveGeneral} onDuplicate={() => undefined}>{fields}</SaveForm> : <div className="lims-stack">{fields}</div>}
      </section>

      {priceList.owner_kind === 'default' ? (
        <p>The default list applies to everyone who has no list of their own.</p>
      ) : (
        <Assignments priceList={priceList} ownerLabels={ownerLabels} manage={manage} canCentres={permissions.includes('identity.centre.read')} />
      )}

      <section aria-label="Versions">
        <h2 className="lims-section-title">Versions</h2>
        <table className="lims-table lims-table-regular">
          <caption className="lims-visually-hidden">Versions</caption>
          <thead>
            <tr>{['Version', 'Status', 'Effective from', 'Effective to', 'Items', 'Source', 'Change reason', 'Published by'].map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}</tr>
          </thead>
          <tbody>
            {priceList.versions.map((v) => (
              <tr key={v.id} className="lims-row">
                <td className="lims-cell"><a className="lims-link" href={`/catalog/price-lists/${priceList.id}/versions/${v.id}`}>{`v${v.version_no}`}</a></td>
                <td className="lims-cell"><Badge tone={STATUS_TONE[v.status] ?? 'neutral'}>{STATUS_LABEL[v.status] ?? v.status}</Badge></td>
                <td className="lims-cell">{fmtDateTime(v.effective_from) || '—'}</td>
                <td className="lims-cell">{fmtDateTime(v.effective_to) || '—'}</td>
                <td className="lims-cell">{v.item_count}</td>
                <td className="lims-cell">{v.source_import_id ? 'Import' : 'Manual'}</td>
                <td className="lims-cell">{v.change_reason ?? '—'}</td>
                <td className="lims-cell">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

function Assignments({ priceList, ownerLabels, manage, canCentres }: { priceList: Detail; ownerLabels: Readonly<Record<string, string>>; manage: boolean; canCentres: boolean }) {
  const router = useRouter();
  const kind = priceList.owner_kind;
  const original = priceList.assignments.map((a) => a.owner_id);
  const [ids, setIds] = useState(original);
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>(ownerLabels);
  const [n, setN] = useState(0); // remounts the combobox after each pick so its text is cleared
  const [fail, setFail] = useState<Fail>();
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const dirty = ids.length !== original.length || ids.some((id, i) => id !== original[i]);
  const full = ids.length >= MAX_ASSIGNMENTS;
  const k = kind as Exclude<PriceOwnerKind, 'default'>;

  const save = async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      const r = await replaceAssignmentsAction(priceList.id, priceList.version, ids);
      if (r.ok) router.refresh();
      else setFail(r);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-label="Assignments">
      <h2 className="lims-section-title">Assignments</h2>
      {fail?.code === 'catalog.code_duplicate' ? (
        <div role="alert"><Banner tone="danger" title="One of these owners already has another price list." /></div>
      ) : fail ? <FailBanner fail={fail} /> : null}
      {manage && (kind !== 'centre' || canCentres) ? (
        <Combobox<Owner>
          key={n}
          label={ADD_LABEL[k]}
          name="add_owner"
          isDisabled={full}
          loadOptions={async (q) => (await searchOwners(kind, q)).filter((o) => !ids.includes(o.id))}
          getKey={(o) => o.id}
          renderOption={(o) => o.label}
          renderValue={(o) => o.label}
          onChange={(o) => {
            if (!o) return;
            setIds((x) => [...x, o.id]);
            setLabels((l) => ({ ...l, [o.id]: o.label }));
            setN((x) => x + 1);
          }}
        />
      ) : null}
      {manage && kind === 'centre' && !canCentres ? <p className="lims-description">Centres can be assigned with the permission identity.centre.read.</p> : null}
      {full ? <p role="note">{`${MAX_ASSIGNMENTS} of ${MAX_ASSIGNMENTS} assigned. Remove one to add another.`}</p> : null}
      {ids.length === 0 ? (
        <p>Nothing is assigned yet.</p>
      ) : (
        <table className="lims-table lims-table-compact">
          <caption className="lims-visually-hidden">{`Assigned (${ids.length})`}</caption>
          <thead><tr><th scope="col">Owner</th>{manage ? <th scope="col"><VisuallyHidden>Actions</VisuallyHidden></th> : null}</tr></thead>
          <tbody>
            {ids.map((id) => (
              <tr key={id}>
                <td>{labels[id] ?? id}</td>
                {manage ? <td><Button size="sm" variant="ghost" onPress={() => setIds((x) => x.filter((y) => y !== id))}>Remove<VisuallyHidden> assignment</VisuallyHidden></Button></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {manage ? <Button variant="primary" isDisabled={!dirty} isLoading={busy} onPress={save}>Save assignments</Button> : null}
    </section>
  );
}

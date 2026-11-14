'use client';
// C16.T-B6 W5 Bookable catalogue (04-UI-UX W5; TRD S12–S14). Active is an inline-save Switch; [Add test or package] searches the C3 catalogue
// through the BFF; [Refresh from catalogue] starts S14. One primary button on the page (LD-140).
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { bookingProblem, dateTime, type BookingKind, type StaffBookableItem } from './booking-model';

export interface CatalogHit { orderable_id: string; orderable_kind: 'test' | 'panel'; code: string; display_name: string }
export interface AddBookableBody { orderable_id: string; orderable_kind: 'test' | 'panel'; booking_kinds: BookingKind[]; is_active: boolean }
export interface BookableCatalogueActions {
  setActive(item: StaffBookableItem, isActive: boolean): Promise<void>;
  searchCatalog(q: string): Promise<CatalogHit[]>;
  add(body: AddBookableBody): Promise<void>;
  refresh(): Promise<void>;
}
export interface BookableCatalogueProps { items: readonly StaffBookableItem[]; actions: BookableCatalogueActions }

const KIND = { test: 'Test', panel: 'Panel' } as const;
const TYPES: Record<BookingKind, string> = { centre_visit: 'Centre', home_collection: 'Home' };

function AddDialog({ actions, onClose, onAdded }: { actions: BookableCatalogueActions; onClose: () => void; onAdded: (name: string) => void }) {
  const [hit, setHit] = useState<CatalogHit>();
  const [kinds, setKinds] = useState<BookingKind[]>([]);
  const [errors, setErrors] = useState<{ hit?: string; kinds?: string }>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toggle = (k: BookingKind, on: boolean) => setKinds((l) => (on ? (l.includes(k) ? l : [...l, k]) : l.filter((x) => x !== k)));

  const save = async () => {
    if (busy) return;
    const e = { ...(hit ? {} : { hit: 'Choose a test or package' }), ...(kinds.length ? {} : { kinds: 'Choose at least one booking type' }) };
    setErrors(e);
    if (!hit || !kinds.length) return;
    setBusy(true);
    try {
      await actions.add({ orderable_id: hit.orderable_id, orderable_kind: hit.orderable_kind, booking_kinds: kinds, is_active: true });
      onAdded(hit.display_name);
    } catch (err) {
      setFailure(bookingProblem(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Add test or package"
      isOpen
      onClose={onClose}
      size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>Add</Button></>}
    >
      <Combobox<CatalogHit>
        label="Test or package" name="orderable_id" isRequired value={hit} onChange={setHit} {...(errors.hit ? { error: errors.hit } : {})}
        loadOptions={(q) => actions.searchCatalog(q)} getKey={(h) => h.orderable_id} renderValue={(h) => h.display_name}
        renderOption={(h) => `${h.code} · ${h.display_name}`}
      />
      <fieldset className="lims-fieldset">
        <legend>Booking types</legend>
        <Checkbox label="Centre visit" isSelected={kinds.includes('centre_visit')} onChange={(on) => toggle('centre_visit', on)} />
        <Checkbox label="Home collection" isSelected={kinds.includes('home_collection')} onChange={(on) => toggle('home_collection', on)} />
        {errors.kinds ? <p role="alert" className="lims-error">{errors.kinds}</p> : null}
      </fieldset>
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
    </Dialog>
  );
}

export function BookableCatalogue({ items: initial, actions }: BookableCatalogueProps) {
  const toast = useToast();
  const [items, setItems] = useState<readonly StaffBookableItem[]>(initial);
  useEffect(() => setItems(initial), [initial]); // fresh rows (new versions) after router.refresh()
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const setOne = (id: string, is_active: boolean) => setItems((l) => l.map((x) => (x.orderable_id === id ? { ...x, is_active } : x)));

  const toggle = async (item: StaffBookableItem, next: boolean) => {
    setOne(item.orderable_id, next); // optimistic; put back on failure
    try {
      await actions.setActive(item, next);
      setFailure(undefined);
    } catch (err) {
      setOne(item.orderable_id, item.is_active);
      setFailure(`Could not save ${item.display_name}. ${bookingProblem(err)}`);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await actions.refresh();
      toast.show({ tone: 'success', title: 'Refresh started' });
    } catch (err) {
      setFailure(bookingProblem(err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="lims-stack">
      <div className="lims-inline">
        <Button variant="primary" onPress={() => setAdding(true)}>Add test or package</Button>
        <Button isLoading={refreshing} onPress={() => void refresh()}>Refresh from catalogue</Button>
      </div>
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
      <DataTable
        caption="Bookable catalogue"
        rows={items}
        getRowId={(i) => i.orderable_id}
        emptyState={{ title: 'No bookable tests yet.' }}
        columns={[
          { id: 'code', header: 'Code', isRowHeader: true, cell: (i) => <span className="lims-mono">{i.code}</span> },
          { id: 'name', header: 'Name', cell: (i) => i.display_name },
          { id: 'kind', header: 'Kind', cell: (i) => KIND[i.kind] ?? i.kind },
          { id: 'types', header: 'Types', cell: (i) => i.booking_kinds.map((k) => TYPES[k] ?? k).join(', ') },
          { id: 'price', header: 'Indicative price', align: 'end', cell: (i) => (i.indicative_price ? <MoneyText value={{ amountPaisa: i.indicative_price.amount_paisa, currency: 'NPR' }} /> : '—') },
          { id: 'synced', header: 'Synced at', cell: (i) => (i.synced_at ? dateTime(i.synced_at) : '—') },
          { id: 'active', header: 'Active', cell: (i) => <Switch label={`Active: ${i.display_name}`} isSelected={i.is_active} onChange={(on) => void toggle(i, on)} /> },
        ]}
      />
      {adding ? <AddDialog actions={actions} onClose={() => setAdding(false)} onAdded={(name) => { setAdding(false); toast.show({ tone: 'success', title: `${name} added` }); }} /> : null}
    </div>
  );
}

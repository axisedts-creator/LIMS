'use client';
// SCR-15 Price simulator (04-UI-UX §4). The client sends only ids + priority + context ids (+ optional instant): never a price,
// tenant or status (AB-10, REQ-SEC-046). Prices, surcharge and tax come back from the API; the disclaimer sits under the result.
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { searchDoctorsAction, searchOrderablesAction } from '../server/catalogActions';
import { quotePricesAction, searchCentresAction, searchCreditPartiesAction, searchPriceListsAction } from '../server/pricingActions';
import type { OrderableSummary, PriceQuoteLine, PriceQuoteResult } from '../server/types';
import { CatalogForbidden } from './CatalogForbidden';
import { FailBanner, type Fail } from './shared';
import { npr, PERM_READ, TaxDisclaimer } from './pricing-ui';

interface Opt { id: string; label: string }
type Priority = 'routine' | 'urgent';
const SOURCE: Record<PriceQuoteLine['source'], string> = { explicit: 'Explicit', credit_party: 'Hospital-company', referrer: 'Doctor', centre: 'Centre', tenant_default: 'Default' };
const ERRORS: Record<string, string> = {
  'catalog.no_price': 'No price found for this orderable.',
  'catalog.tax_config_missing': 'Tax is not configured: a lab default tax rule is needed.',
};
const pct = (bp: number) => `${bp / 100} %`;
const isLine = (q: PriceQuoteResult): q is PriceQuoteLine => 'unit_price' in q;

/** One optional context picker; picking sets the id, clearing the text clears it. */
function Pick({ label, load, onChange }: { label: string; load: (q: string) => Promise<Opt[]>; onChange: (o: Opt | undefined) => void }) {
  return <Combobox<Opt> label={label} name={label} loadOptions={load} getKey={(o) => o.id} renderOption={(o) => o.label} renderValue={(o) => o.label} onChange={onChange} />;
}

export function PriceSimulator({ permissions }: { permissions: readonly string[] }) {
  const [picked, setPicked] = useState<readonly OrderableSummary[]>([]);
  const [n, setN] = useState(0); // remounts the Orderables combobox after each pick so its text is cleared
  const [priority, setPriority] = useState<Priority>('routine');
  const [ctx, setCtx] = useState<Readonly<Record<string, string | undefined>>>({});
  const [at, setAt] = useState<string>();
  const [quotes, setQuotes] = useState<readonly PriceQuoteResult[]>();
  const [lists, setLists] = useState<Readonly<Record<string, string>>>({});
  const [fail, setFail] = useState<Fail>();
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  if (!permissions.includes(PERM_READ)) return <CatalogForbidden />;
  const setCtxId = (k: string) => (o: Opt | undefined) => setCtx((c) => ({ ...c, [k]: o?.id }));

  const run = async () => {
    if (inflight.current || picked.length === 0) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      const context = Object.fromEntries(Object.entries(ctx).filter(([, v]) => v));
      const r = await quotePricesAction({ items: picked.map((o) => ({ orderable_id: o.id, priority })), context, ...(at ? { at } : {}) });
      if (r.ok) {
        setQuotes(r.data);
        void searchPriceListsAction('').then((l) => setLists(Object.fromEntries(l.map((x) => [x.id, x.label.split(' — ')[0]!]))));
      } else setFail(r);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const nameOf = (id: string) => { const o = picked.find((x) => x.id === id); return o ? `${o.code} — ${o.name}` : id; };
  return (
    <section aria-label="Price simulator">
      <PageHeader title="Price simulator" helpKey="catalog.price_simulator" breadcrumbs={[{ label: 'Pricing' }, { label: 'Price simulator' }]} />
      <Form onSubmit={run} errorSummary={false}>
        <Combobox<OrderableSummary>
          key={n}
          label="Orderables"
          name="orderables"
          description={picked.length >= 50 ? 'Up to 50 orderables.' : 'Search by code or name.'}
          isDisabled={picked.length >= 50}
          loadOptions={async (q) => (await searchOrderablesAction(q)).filter((o) => !picked.some((p) => p.id === o.id))}
          getKey={(o) => o.id}
          renderOption={(o) => `${o.code} — ${o.name}${o.kind === 'panel' ? ' (panel)' : ''}`}
          renderValue={(o) => o.name}
          onChange={(o) => {
            if (!o) return;
            setPicked((p) => [...p, o]);
            setN((x) => x + 1);
          }}
        />
        {picked.length ? (
          <ul aria-label="Selected tests and panels">
            {picked.map((o) => (
              <li key={o.id}>
                {`${o.code} — ${o.name}`}{' '}
                <Button size="sm" variant="ghost" onPress={() => setPicked((p) => p.filter((x) => x.id !== o.id))}>Remove<VisuallyHidden> {o.code}</VisuallyHidden></Button>
              </li>
            ))}
          </ul>
        ) : null}
        <RadioGroup<Priority> label="Priority" name="priority" orientation="horizontal" value={priority} onChange={setPriority} options={[{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }]} />
        <Pick label="Price list" load={searchPriceListsAction} onChange={setCtxId('price_list_id')} />
        <Pick label="Credit party" load={searchCreditPartiesAction} onChange={setCtxId('credit_party_id')} />
        <Pick label="Doctor" load={async (q) => { const r = await searchDoctorsAction(q); return r.ok ? r.data.map((d) => ({ id: d.id, label: `${d.doctor_code} — ${d.display_name}` })) : []; }} onChange={setCtxId('referrer_id')} />
        {permissions.includes('identity.centre.read') ? (
          <Pick label="Centre" load={async (q) => (await searchCentresAction(q)).map((c) => ({ id: c.centre_id, label: `${c.code} — ${c.name}` }))} onChange={setCtxId('centre_id')} />
        ) : null}
        <DateTimePicker label="At" name="at" description="Leave empty for now." {...(at ? { value: at as never } : {})} onChange={setAt as never} />
        <Button type="submit" variant="primary" isLoading={busy} isDisabled={picked.length === 0}>Get price</Button>
      </Form>
      {fail ? <FailBanner fail={fail} /> : null}
      {quotes ? (
        <table className="lims-table lims-table-regular">
          <caption className="lims-visually-hidden">Price result</caption>
          <thead>
            <tr>{['Orderable', 'Price list used', 'Source', 'Version', 'Unit price', 'Urgent surcharge', 'VAT', 'Other tax', 'HS code', 'Error'].map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}</tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.orderable_id} className="lims-row">
                <td className="lims-cell">{nameOf(q.orderable_id)}</td>
                {isLine(q) ? (
                  <>
                    <td className="lims-cell">{lists[q.price_list_id] ?? '—'}</td>
                    <td className="lims-cell">{SOURCE[q.source]}</td>
                    <td className="lims-cell">{`v${q.price_list_version}`}</td>
                    <td className="lims-cell">{npr(q.unit_price.amount_paisa)}</td>
                    <td className="lims-cell">{q.urgent_surcharge ? npr(q.urgent_surcharge.amount_paisa) : '—'}</td>
                    <td className="lims-cell">{q.tax.vat === 'exempt' ? 'Exempt' : `Taxable${q.tax.vat_rate_bp !== undefined ? ` ${pct(q.tax.vat_rate_bp)}` : ''}`}</td>
                    <td className="lims-cell">{q.tax.other_tax_code ? `${q.tax.other_tax_code}${q.tax.other_tax_rate_bp !== undefined ? ` ${pct(q.tax.other_tax_rate_bp)}` : ''}` : '—'}</td>
                    <td className="lims-cell">{q.tax.hs_code ?? '—'}</td>
                    <td className="lims-cell">—</td>
                  </>
                ) : (
                  <>
                    <td className="lims-cell" colSpan={8}>—</td>
                    <td className="lims-cell">{ERRORS[q.error_code] ?? 'This orderable could not be priced.'}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Pick orderables and a context to see the price.</p>
      )}
      <TaxDisclaimer />
    </section>
  );
}

'use client';
// 04-UI-UX §8.6 Credit party detail: Terms, Charges, Statement tabs (read views). Editing terms (B?), monthly bill generation (B21) and party payments
// are listed as open points in .orchestra/notes/BL-T20-impl.md — they need a branch list and a bill picker the shell does not provide yet.
import { useState } from 'react';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import type { CreditParty, Money } from '../server/types';
import { Ad, formatNpr, humanize, npr } from './format';

export interface Charge { id: string; order_id?: string; invoice_id?: string; status: string; amount: Money; created_at: string }
export interface StatementMonth { period_month: string; fiscal_year_bs: string; invoiced: Money; paid: Money; credited: Money; closing_balance: Money }
type Tab = 'terms' | 'charges' | 'statement';

export function CreditPartyDetail({ party, charges, statement }: { party: CreditParty; charges: readonly Charge[]; statement: readonly StatementMonth[] }) {
  const [tab, setTab] = useState<Tab>('terms');
  const chargeCols: ColumnDef<Charge>[] = [
    { id: 'when', header: 'Created', isRowHeader: true, cell: (c) => <Ad value={c.created_at} withTime /> },
    { id: 'status', header: 'Status', cell: (c) => humanize(c.status) },
    { id: 'amount', header: 'Amount', align: 'end', cell: (c) => npr(c.amount) },
    { id: 'invoice', header: 'Invoice', cell: (c) => (c.invoice_id ? <a className="lims-link" href={`/billing/invoices/${c.invoice_id}`}>Open invoice</a> : '—') },
  ];
  const stmtCols: ColumnDef<StatementMonth>[] = [
    { id: 'month', header: 'Month', isRowHeader: true, cell: (m) => m.period_month },
    { id: 'fy', header: 'Fiscal year', cell: (m) => m.fiscal_year_bs },
    // RS-C4 / LD-140 (10-DESIGN-SYSTEM s4 Accounts): Opening is derived from served data (closing - invoiced + paid + credited = previous month's closing); no new field.
    { id: 'opening', header: 'Opening', align: 'end', cell: (m) => npr({ ...m.closing_balance, amount_paisa: m.closing_balance.amount_paisa - m.invoiced.amount_paisa + m.paid.amount_paisa + m.credited.amount_paisa }) },
    { id: 'invoiced', header: 'Invoiced', align: 'end', cell: (m) => npr(m.invoiced) },
    { id: 'paid', header: 'Paid', align: 'end', cell: (m) => npr(m.paid) },
    { id: 'credited', header: 'Credited', align: 'end', cell: (m) => npr(m.credited) },
    { id: 'closing', header: 'Closing', align: 'end', cell: (m) => npr(m.closing_balance) },
  ];
  return (
    <section aria-label={`Credit party ${party.name}`}>
      <PageHeader title={party.name} helpKey="billing.credit_party" breadcrumbs={[{ label: 'Credit parties', href: '/billing/credit-parties' }, { label: party.code }]} />
      <Tabs items={[{ id: 'terms', label: 'Terms' }, { id: 'charges', label: 'Charges' }, { id: 'statement', label: 'Statement' }]} selectedId={tab} onChange={(id) => setTab(id as Tab)} aria-label="Credit party">
        {tab === 'terms' ? (
          <DescriptionList
            items={[
              { term: 'Code', value: party.code },
              { term: 'Credit limit', value: formatNpr(party.credit_limit_paisa) },
              { term: 'Outstanding', value: npr(party.outstanding) },
              { term: 'Credit days', value: String(party.credit_days) },
              { term: 'Lock', value: party.is_locked ? `Locked${party.lock_reason_code ? ` — ${humanize(party.lock_reason_code)}` : ''}` : 'Open' },
            ]}
          />
        ) : null}
        {tab === 'charges' ? <DataTable caption="Charges" columns={chargeCols} rows={charges} getRowId={(c) => c.id} emptyState={{ title: 'No charges yet.' }} /> : null}
        {tab === 'statement' ? <DataTable caption="Statement" columns={stmtCols} rows={statement} getRowId={(m) => m.period_month} emptyState={{ title: 'No statement months yet.' }} /> : null}
      </Tabs>
    </section>
  );
}

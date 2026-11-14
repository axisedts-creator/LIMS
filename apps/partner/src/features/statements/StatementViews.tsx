'use client';
// C13.T19 PS-1 Statements and PS-2 Month (04-UI-UX PS-1/PS-2; US-12.1..12.4). Information only: a neutral banner is always shown; wording is "statement / billed / paid" (04-UI-UX §6).
// A.D. month name + year and the B.S. fiscal year are both shown (02-CV §13). Empty = empty state, never an error. LD-140: @lims/ui components only; no primary button.
import { Banner } from '@lims/ui/components/Banner';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { StatTile } from '@lims/ui/components/StatTile';
import { Dt, ListScreen, RowLink, type ListColumn } from '../common/ui';
import { lakh, monthLabel, money } from '../common/format';
import type { Money, StatementMonth } from '../common/types';

const NOTE = 'This statement is for information. It is not a tax invoice.';
const rowId = (r: StatementMonth) => `${r.period_month}:${r.fiscal_year_bs}`;

const columns = (link: boolean): ListColumn<StatementMonth>[] => [
  { id: 'month', header: 'Month', isRowHeader: true, cell: (r) => (link ? <RowLink href={`/statements/${encodeURIComponent(r.period_month)}`}>{monthLabel(r.period_month)}</RowLink> : monthLabel(r.period_month)) },
  { id: 'fiscal_year', header: 'Fiscal year', cell: (r) => r.fiscal_year_bs },
  { id: 'billed', header: 'Billed', align: 'end', cell: (r) => <MoneyText value={money(r.invoiced)} /> },
  { id: 'paid', header: 'Paid', align: 'end', cell: (r) => <MoneyText value={money(r.paid)} /> },
  { id: 'credited', header: 'Credited', align: 'end', cell: (r) => <MoneyText value={money(r.credited)} /> },
  { id: 'closing', header: 'Closing balance', align: 'end', cell: (r) => <MoneyText value={money(r.closing_balance)} /> },
];

export function StatementList({ rows, nextCursor, outstanding, asOf }: { rows: StatementMonth[]; nextCursor?: string | undefined; outstanding?: Money | undefined; asOf?: string | undefined }) {
  return (
    <>
      <PageHeader title="Statements" helpKey="partners.statements" />
      <Stack gap={4}>
        <Banner tone="neutral" title={NOTE} />
        {outstanding && Number.isFinite(outstanding.amount_paisa) ? (
          <div>
            <StatTile label="Outstanding balance" value={lakh(outstanding.amount_paisa)} />
            {asOf ? <span className="lims-stat-note">as of <Dt value={asOf} withTime /></span> : null}
          </div>
        ) : null}
        <ListScreen caption="Statements by month" columns={columns(true)} rows={rows} getRowId={rowId} nextCursor={nextCursor} empty={{ title: 'No statements yet.', body: 'Statements appear here after the lab bills your organisation.' }} />
      </Stack>
    </>
  );
}

export function StatementMonthView({ month, rows }: { month: string; rows: StatementMonth[] }) {
  return (
    <>
      <PageHeader title={`Statement for ${monthLabel(month)}`} helpKey="partners.statements" breadcrumbs={[{ label: 'Statements', href: '/statements' }, { label: monthLabel(month) }]} />
      <Stack gap={4}>
        <Banner tone="neutral" title={NOTE} />
        <ListScreen caption={`Statement for ${monthLabel(month)}`} columns={columns(false)} rows={rows} getRowId={rowId} empty={{ title: 'Nothing was billed in this month.' }} />
      </Stack>
    </>
  );
}

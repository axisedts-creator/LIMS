'use client';
// C13.T19 PP-1 Price list (04-UI-UX PP-1; US-11.1/11.2/11.5). Search (code/name, <= 64, non-PHI) + Kind / Rate filters; info banner with the urgent-surcharge sentence, update time and list version.
// LD-140 (2026-11-13): @lims/ui components only; no primary button on this page.
import { useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { Form } from '@lims/ui/components/Form';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { Dt, ListScreen, useApplyFilters, type ListColumn } from '../common/ui';
import { money } from '../common/format';
import type { PriceListItem } from '../common/types';

export interface PriceListProps {
  rows: PriceListItem[];
  nextCursor?: string | undefined;
  version?: number | undefined;
  syncedAt?: string | undefined;
  initial: { q?: string; kind?: string; source?: string };
}

export function PriceList({ rows, nextCursor, version, syncedAt, initial }: PriceListProps) {
  const apply = useApplyFilters();
  const [q, setQ] = useState(initial.q ?? '');
  const [f, setF] = useState<FilterValue>({ ...(initial.kind ? { kind: initial.kind } : {}), ...(initial.source ? { source: initial.source } : {}) });
  const push = (v: FilterValue, text = q) => {
    setF(v);
    apply({ q: text.trim() || undefined, kind: typeof v['kind'] === 'string' ? v['kind'] : undefined, source: typeof v['source'] === 'string' ? v['source'] : undefined });
  };

  const columns: ListColumn<PriceListItem>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (r) => <span className="lims-mono">{r.code}</span> },
    { id: 'name', header: 'Name', cell: (r) => r.name },
    { id: 'kind', header: 'Kind', cell: (r) => (r.kind === 'panel' ? 'Package' : 'Test') },
    { id: 'department', header: 'Department', hideBelow: 'md', cell: (r) => r.department_name ?? '—' },
    { id: 'price', header: 'Price', align: 'end', cell: (r) => <MoneyText value={money(r.unit_price)} /> },
    { id: 'source', header: 'Rate', cell: (r) => (r.source === 'standard' ? <Badge tone="info">Standard rate</Badge> : 'Your rate') },
    { id: 'effective_from', header: 'Valid from', hideBelow: 'lg', cell: (r) => <Dt value={r.effective_from} /> },
  ];

  return (
    <>
      <PageHeader title="Price list" helpKey="partners.price_list" />
      <Stack gap={4}>
        <Banner tone="info" title="Urgent tests may carry an extra charge. The amount on your statement is final.">
          {syncedAt ? <p>Prices updated <Dt value={syncedAt} withTime /></p> : null}
          {version !== undefined ? <p>{`Price list version ${version}`}</p> : null}
        </Banner>
        <Form onSubmit={() => push(f)} submitShortcut={false}>
          <div className="partner-toolbar">
            <TextField label="Search by code or name" name="q" maxLength={64} value={q} onChange={setQ} />
            <Button type="submit">Search</Button>
          </div>
        </Form>
        <FilterBar
          filters={[
            { id: 'kind', label: 'Kind', kind: 'select', options: [{ value: 'test', label: 'Test' }, { value: 'panel', label: 'Package' }] },
            { id: 'source', label: 'Rate', kind: 'select', options: [{ value: 'partner', label: 'Your rate' }, { value: 'standard', label: 'Standard rate' }] },
          ]}
          value={f}
          onChange={(v) => push(v)}
          onReset={() => { setQ(''); push({}, ''); }}
        />
        <ListScreen
          caption="Price list"
          columns={columns}
          rows={rows}
          getRowId={(r) => r.orderable_id}
          nextCursor={nextCursor}
          empty={{ title: 'No prices are set up for your organisation yet. Contact the lab.' }}
        />
      </Stack>
    </>
  );
}

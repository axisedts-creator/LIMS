'use client';
// T0D-PRICETOOLS-1 (LD-321, LD-353 template 5 without charts): "Compare price lists" at /catalog/price-lists?view=compare&a=&b= (no new route).
// Two pickers "Version A" / "Version B" built from the lists the page already loaded; the choice lives in the URL and the server page fetches the first
// page. Table Test, Price A, Price B, Difference, Percent (rupees from integer paisa; an absent price is a dash, never 0.00), Load more, Print and a CSV
// export built by hand (every page, formula-injection safe). Readers can use all of it (catalog.price_list.read).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { t } from '@/core/i18n/messages';
import type { PriceComparisonRow } from '../server/priceTools.server';
import { comparePriceListsAction } from '../server/pricingActions';
import type { PriceList } from '../server/types';
import { csvCell, fmt2, saveBlob } from './priceToolsMath';

export type CompareState = 'ready' | 'same' | 'incomplete';
const k = (s: string) => t(`catalog.price_tools.compare.${s}`);
const DASH = '—';
const money = (p: number | undefined) => (p === undefined ? DASH : fmt2(p));
const pct = (bp: number | undefined) => (bp === undefined ? DASH : `${fmt2(bp)}%`);

/** One option per current, scheduled and draft version of every loaded list. */
export function versionOptions(lists: readonly PriceList[]) {
  return lists.flatMap((l) => [
    ...(l.current_version ? [{ value: l.current_version.id, label: `${l.code} · v${l.current_version.version_no} (${k('current')})` }] : []),
    ...(l.scheduled_version ? [{ value: l.scheduled_version.id, label: `${l.code} · v${l.scheduled_version.version_no} (${k('scheduled')})` }] : []),
    ...(l.draft_version_id ? [{ value: l.draft_version_id, label: `${l.code} · ${k('draft')}` }] : []),
  ]);
}

function toCsv(rows: readonly PriceComparisonRow[]): string {
  const head = 'Test code,Test name,Price A (NPR),Price B (NPR),Difference (NPR),Percent (%)';
  const num = (n: number | undefined) => (n === undefined ? '' : fmt2(n));
  const lines = rows.map((r) => [csvCell(r.test_code, true), csvCell(r.test_name, true), num(r.price_a_paisa), num(r.price_b_paisa), num(r.difference_paisa), num(r.percent_bp)].join(','));
  return `﻿${[head, ...lines].join('\r\n')}\r\n`;
}

export function PriceCompare({ lists, a, b, state, rows: first, next: firstNext, fail: firstFail }: {
  lists: readonly PriceList[];
  a?: string | undefined;
  b?: string | undefined;
  state: CompareState;
  rows: readonly PriceComparisonRow[];
  next?: string | undefined;
  /** The server's own text of a 404 / 400 refusal. */
  fail?: string | undefined;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(first);
  const [next, setNext] = useState(firstNext);
  const [fail, setFail] = useState(firstFail);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const options = versionOptions(lists);

  const go = (va: string | undefined, vb: string | undefined) =>
    router.push(`/catalog/price-lists?${new URLSearchParams({ view: 'compare', ...(va ? { a: va } : {}), ...(vb ? { b: vb } : {}) }).toString()}`);

  /** Fetches the pages after `next` (all of them when `all`); appends them to the table. Undefined when a page failed. */
  const more = async (all: boolean): Promise<PriceComparisonRow[] | undefined> => {
    if (!a || !b) return undefined;
    let acc = [...rows];
    let cur = next;
    while (cur) {
      const r = await comparePriceListsAction(a, b, cur).catch(() => undefined);
      if (!r?.ok) {
        setFail(r?.detail ?? k('failed'));
        return undefined;
      }
      acc = [...acc, ...r.data.data];
      cur = r.data.page.next_cursor;
      if (!all) break;
    }
    setRows(acc);
    setNext(cur);
    return acc;
  };
  const guarded = (f: () => Promise<void>) => async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      await f();
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };
  const loadMore = guarded(async () => { await more(false); });
  const exportCsv = guarded(async () => {
    const all = await more(true);
    if (all) saveBlob('price-list-comparison.csv', new Blob([toCsv(all)], { type: 'text/csv;charset=utf-8' }));
  });

  const head = [k('test'), k('price_a'), k('price_b'), k('difference'), k('percent')];
  const message = state === 'same' ? k('same') : state === 'incomplete' ? k('pick_two') : k('empty');
  return (
    <section aria-label={k('title')} className="lims-stack">
      <PageHeader title={k('title')} helpKey="catalog.price_lists" actions={<a className="lims-link" href="/catalog/price-lists">{k('back')}</a>} />
      <div className="lims-filter-bar">
        <Select<string> label={k('a')} name="version_a" {...(a ? { value: a } : {})} onChange={(v) => go(v, b)} options={options} />
        <Select<string> label={k('b')} name="version_b" {...(b ? { value: b } : {})} onChange={(v) => go(a, v)} options={options} />
        <Button variant="secondary" isDisabled={rows.length === 0} onPress={() => window.print()}>{k('print')}</Button>
        <Button variant="secondary" isDisabled={rows.length === 0} isLoading={busy} onPress={() => void exportCsv()}>{k('csv')}</Button>
      </div>
      {state !== 'ready' ? <p role="status">{message}</p> : null}
      {fail ? <div role="alert" className="lims-error"><p>{fail}</p></div> : null}
      <div className="lims-table-scroll">
        <table className="lims-table lims-table-compact">
          <caption className="lims-visually-hidden">{k('caption')}</caption>
          <thead><tr>{head.map((h, i) => <th key={h} scope="col" className={i ? 'lims-col lims-num' : 'lims-col'}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={5}>{message}</EmptyRow> : null}
            {rows.map((r) => (
              <tr key={r.orderable_id} className="lims-row">
                <td className="lims-cell" title={r.test_name}><span>{r.test_code}</span> {r.test_name}</td>
                <td className="lims-cell lims-num">{money(r.price_a_paisa)}</td>
                <td className="lims-cell lims-num">{money(r.price_b_paisa)}</td>
                <td className="lims-cell lims-num">{r.price_a_paisa === undefined || r.price_b_paisa === undefined ? DASH : money(r.difference_paisa)}</td>
                <td className="lims-cell lims-num">{pct(r.percent_bp)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length === 0 ? <PlaceholderRows colSpan={5} /> : null}
        </table>
      </div>
      {next ? <div><Button variant="ghost" isDisabled={busy} onPress={() => void loadMore()}>{k('load_more')}</Button></div> : null}
    </section>
  );
}

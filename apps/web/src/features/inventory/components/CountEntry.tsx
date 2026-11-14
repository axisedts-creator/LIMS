'use client';
// S11 count entry — BLIND count (04-UI-UX §3 S11). The system quantity is not in the DOM unless an inventory.stock.adjust holder turns on
// "Show system quantity"; for everyone else the server component strips it before it reaches the browser. Variance is the SERVER's
// (counted − (snapshot + movements since the snapshot)); the client never subtracts. Posting needs inventory.stock.adjust + aal2.
// LD-140 (2026-11-13): kit components only; "Post count" is the ONE primary; line state is a word with a tone + icon.
import { useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { lookupBarcodeAction, postCountAction, putCountLinesAction } from '../server/actions';
import type { Count, CountLine, ItemSummary, Lot, UncountedPolicy } from '../server/types';
import { BARCODE_VALUE } from './codes';
import { CountStatusChip } from './CountsView';
import { Chip, isoDate, ProblemBanner, qtyOrZeroError, useAttemptKey, type Failure } from './shared';

/** One line's Counted field: validates on Enter, reports only valid text upward. Its text survives a table rebuild through `drafts`. */
function CountInput({ line, drafts, onCommit }: { line: CountLine; drafts: { current: Record<string, string | undefined> }; onCommit: (l: CountLine, text: string, el: HTMLInputElement) => void }) {
  const [text, setText] = useState<string | undefined>(drafts.current[line.id] ?? line.counted_qty_base);
  const [error, setError] = useState<string>();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    const err = qtyOrZeroError('Counted qty', text);
    setError(err);
    if (!err && text !== undefined) onCommit(line, text, e.target);
  };
  return (
    <div data-line={line.id} onKeyDown={onKey}>
      <DecimalField
        label="Counted qty"
        name={`counted_${line.id}`}
        decimals={3}
        allowNegative
        {...(text !== undefined ? { value: text } : {})}
        {...(error ? { error } : {})}
        onChange={(v) => {
          drafts.current[line.id] = v;
          setText(v);
        }}
      />
    </div>
  );
}

export function CountEntry({ count, storeName, items, lots, canManage, canAdjust }: { count: Count; storeName: string; items: readonly ItemSummary[]; lots: readonly Lot[]; canManage: boolean; canAdjust: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const key = useAttemptKey();
  const root = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<CountLine[]>(count.lines);
  // Typed-but-unsaved text lives in a ref, not state: a parent re-render per keystroke rebuilds the table cells and drops focus.
  const drafts = useRef<Record<string, string | undefined>>({});
  const [problem, setProblem] = useState<Failure>();
  const [showSystem, setShowSystem] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [policy, setPolicy] = useState<UncountedPolicy>('skip');
  const [scanMsg, setScanMsg] = useState('');
  const open = count.status === 'open';
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const lotNo = (id: string | undefined) => lots.find((l) => l.id === id)?.lot_no ?? '—';

  const inputs = () => [...(root.current?.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]') ?? [])];
  const focusNext = (from: HTMLInputElement | undefined) => {
    const all = inputs();
    const i = from ? all.indexOf(from) : -1;
    (all.slice(i + 1).find((el) => el.value === '') ?? all[i + 1])?.focus();
  };

  const save = async (l: CountLine, text: string, from: HTMLInputElement) => {
    const r = await putCountLinesAction(count.id, [{ line_id: l.id, item_id: l.item_id, ...(l.lot_id ? { lot_id: l.lot_id } : {}), counted_qty_base: text }]);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    setLines((cur) => cur.map((x) => r.data.lines.find((u) => u.id === x.id) ?? x));
    // the rebuilt table replaces the input that was focused: move on from its position
    setTimeout(() => focusNext(from.isConnected ? from : inputs()[Math.max(0, lines.findIndex((x) => x.id === l.id))]), 0);
  };

  const onScan = async (value: string) => {
    const r = await lookupBarcodeAction(value); // the scanned value goes in the POST body only, never a URL or a log
    if (!r.ok) return setScanMsg(r.status === 404 ? 'No item has this barcode.' : 'The barcode could not be checked.');
    const mine = lines.filter((l) => l.item_id === r.data.id);
    const target = mine.find((l) => !l.counted_qty_base) ?? mine[0];
    if (!target) return setScanMsg('This item is not on this count.');
    setScanMsg('');
    root.current?.querySelector<HTMLInputElement>(`[data-line="${target.id}"] input`)?.focus();
  };

  const post = async () => {
    const r = await postCountAction(count.id, count.version, key.get(policy), policy);
    setPosting(false);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    key.reset();
    toast.show({ tone: 'success', title: `Count ${count.count_no} posted` });
    router.refresh();
  };

  const columns: ColumnDef<CountLine>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (l) => { const i = itemOf(l.item_id); return i ? `${i.item_code} · ${i.name}` : l.item_id; } },
    { id: 'lot', header: 'Lot', cell: (l) => lotNo(l.lot_id) },
    // leading no-break space keeps the number apart from the lot text next to it when the table is copied or read as plain text
    ...(showSystem ? [{ id: 'system', header: 'System qty', align: 'end' as const, cell: (l: CountLine) => ` ${l.book_qty_snapshot ?? '—'} ${itemOf(l.item_id)?.base_uom_code ?? ''}` }] : []),
    {
      id: 'counted',
      header: 'Counted',
      cell: (l) => (open && canManage ? <CountInput line={l} drafts={drafts} onCommit={save} /> : (l.counted_qty_base ?? '—')),
    },
    { id: 'state', header: 'Line', cell: (l) => (l.counted_qty_base ? <Chip tone="success" label="Recorded" /> : <Chip tone="neutral" label="Not counted" />) },
    ...(reviewing ? [{ id: 'variance', header: 'Variance', align: 'end' as const, cell: (l: CountLine) => (l.variance_qty_base !== undefined ? l.variance_qty_base : '—') }] : []),
  ];

  return (
    <section aria-label="Stock count">
      <PageHeader
        title={`Stock count in ${storeName}`}
        helpKey="inventory.counts"
        status={<CountStatusChip status={count.status} />}
        actions={
          open && canAdjust ? (
            <Inline gap={2}>
              <Button onPress={() => setReviewing((v) => !v)}>{reviewing ? 'Back to counting' : 'Review'}</Button>
              <Button variant="primary" onPress={() => setPosting(true)}>Post count</Button>
            </Inline>
          ) : undefined
        }
      />
      <Stack>
        <ProblemBanner problem={problem} />
        <p>{`Snapshot taken ${isoDate(count.snapshot_at)}. Count what is on the shelf; the system quantity stays hidden so it cannot bias the count.`}</p>
        {open && canAdjust ? <Switch label="Show system quantity" isSelected={showSystem} onChange={setShowSystem} /> : null}
        {open && canManage ? <BarcodeInput label="Scan item barcode" name="scan" pattern={BARCODE_VALUE} autoFocus={false} onScan={(v) => void onScan(v)} /> : null}
        {scanMsg ? <p role="status">{scanMsg}</p> : null}
        <div ref={root}>
          <DataTable caption="Count lines" columns={columns} rows={lines} getRowId={(l) => l.id} emptyState={{ title: 'This count has no lines.' }} />
        </div>
      </Stack>
      <ConfirmDialog
        title="Post count"
        body={
          <RadioGroup
            label="Lines you did not count"
            name="uncounted_policy"
            value={policy}
            onChange={setPolicy}
            options={[
              { value: 'skip', label: 'Leave uncounted lines unchanged' },
              { value: 'zero', label: 'Treat uncounted lines as zero' },
            ]}
          />
        }
        confirmLabel="Post count"
        isOpen={posting}
        onCancel={() => setPosting(false)}
        onConfirm={post}
      />
    </section>
  );
}

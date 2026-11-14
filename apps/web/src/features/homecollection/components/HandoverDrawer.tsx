'use client';
// 04-UI-UX §2.3 W3 handover drawer. Items come from H14 only (barcode + specimen type): the receiving centre never sees visit data (08 A19 D-125, REQ-SEC-017).
// LD-140: kit components only; every outcome shows tone, icon and word. A scanned value is only compared with this handover's barcodes: never logged, stored or sent.
// A retry of the same ticks re-sends the same Idempotency-Key (the server replays); changing a tick is a new submission with a new key.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput, useScanCapture } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Drawer } from '@lims/ui/components/Drawer';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { Stack } from '@lims/ui/components/Stack';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { useToast } from '@lims/ui/components/Toast';
import { HANDOVER_CHANGED, failText, humanize, toneIcon, tubeOutcome } from '../labels';
import { confirmHandoverAction, handoverAction } from '../server/actions';
import { useSubmissionKey } from '../submission';
import type { HandoverDetail, HandoverItem, HandoverSummary } from '../types';

type Iso = DateTextProps['value'];
type Load = { state: 'loading' } | { state: 'error'; text: string } | { state: 'ready'; data: HandoverDetail };

const NOT_IN_HANDOVER = 'This tube is not in this handover.';
const noun = (n: number) => (n === 1 ? 'tube' : 'tubes');

export interface HandoverDrawerProps {
  handover: HandoverSummary;
  isOpen: boolean;
  onClose: () => void;
}

export function HandoverDrawer({ handover, isOpen, onClose }: HandoverDrawerProps) {
  const router = useRouter();
  const toast = useToast();
  const keyFor = useSubmissionKey();
  const busy = useRef(false);
  const done = useRef(false);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [got, setGot] = useState<ReadonlySet<string>>(new Set());
  const [scanError, setScanError] = useState('');
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  // After a confirm the drawer hides itself at once (the parent's onClose may lag), so the modal no longer hides the success toast.
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!isOpen) { setClosed(false); done.current = false; return; }
    let live = true;
    void handoverAction(handover.id).then((r) => {
      if (!live) return;
      if (r.ok) setLoad({ state: 'ready', data: r.data });
      else setLoad({ state: 'error', text: r.status === 403 ? 'You do not have permission to see this handover.' : 'This handover could not be loaded. It may no longer exist.' });
    });
    return () => { live = false; };
  }, [isOpen, handover.id]);

  const data = load.state === 'ready' ? load.data : undefined;
  const pending = data?.status === 'pending';
  const items = data?.items ?? [];
  const total = items.length;
  const missing = items.filter((i) => !got.has(i.specimen_id)).length;

  const onScan = (value: string) => {
    const hit = items.find((i) => i.barcode === value);
    if (!hit) { setScanError(NOT_IN_HANDOVER); return; }
    setScanError('');
    setGot((s) => new Set(s).add(hit.specimen_id)); // a tube already received stays received: a repeat scan is ignored
  };
  useScanCapture({ onScan, enabled: isOpen && !closed && !!pending && !asking });

  const toggle = (id: string, on: boolean) => setGot((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  const submit = async (): Promise<boolean> => {
    if (!data || busy.current || done.current) return false;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const body = data.items.map((i) => ({ specimen_id: i.specimen_id, received: got.has(i.specimen_id) }));
      const res = await confirmHandoverAction(data.id, data.version, body, keyFor(body.map((b) => `${b.specimen_id}:${b.received ? 1 : 0}`).join('|')));
      if (!res.ok) { setError(failText(res, 'Check the tubes and try again.', HANDOVER_CHANGED)); return false; }
      done.current = true; // the drawer is closing: a further click must not send a second request
      setAsking(false);
      setClosed(true);
      toast.show({ tone: 'success', title: 'Handover confirmed.' });
      router.refresh();
      onClose();
      return true;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const confirm = () => {
    if (!pending || asking || busy.current || done.current) return;
    if (missing > 0) setAsking(true);
    else void submit();
  };

  const outcome = (i: HandoverItem) => {
    const [tone, label] = tubeOutcome(i.outcome ?? (pending ? '' : 'received'));
    return (
      <Inline gap={1}>
        <Icon name={toneIcon(tone)} />
        <StatusChip kind="generic" status={i.outcome ?? ''} tone={tone} label={label} />
      </Inline>
    );
  };
  const columns: ColumnDef<HandoverItem>[] = [
    { id: 'barcode', header: 'Barcode', isRowHeader: true, cell: (i) => <span className="lims-mono">{i.barcode}</span> },
    { id: 'type', header: 'Specimen type', cell: (i) => humanize(i.specimen_type_code) },
    pending
      ? { id: 'received', header: 'Received', cell: (i) => <Checkbox label="Received" isSelected={got.has(i.specimen_id)} onChange={(on) => toggle(i.specimen_id, on)} /> }
      : { id: 'outcome', header: 'Outcome', cell: outcome },
  ];

  const n = data ? total : handover.item_count;
  return (
    <Drawer title={`Handover from ${handover.from.display_name} · ${n} ${noun(n)}`} isOpen={isOpen && !closed} onClose={onClose} width="lg">
      {load.state === 'loading' ? <p role="status">Loading…</p> : null}
      {load.state === 'error' ? <div role="alert"><Banner tone="danger" title={load.text} /></div> : null}
      {data ? (
        <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) { e.preventDefault(); confirm(); } }}>
          <Stack>
            {pending ? <BarcodeInput label="Scan tube" name="scan" onScan={onScan} {...(scanError ? { error: scanError } : {})} /> : null}
            {pending ? (
              <p role="status">Received {got.size} of {total}</p>
            ) : (
              <p>
                {data.received_by_display ? `Received by ${data.received_by_display}` : 'Handled'}
                {data.received_at ? <> · <DateText value={data.received_at as Iso} withTime /></> : null}
              </p>
            )}
            <DataTable<HandoverItem> caption="Tubes in this handover" columns={columns} rows={items} getRowId={(i) => i.specimen_id} density="compact" emptyState={{ title: 'No tubes in this handover.' }} />
            {error && !asking ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
            {pending ? (
              <Inline justify="end">
                <Button variant="primary" shortcut="Ctrl+Enter" isLoading={saving} onPress={confirm}>Confirm handover</Button>
              </Inline>
            ) : null}
          </Stack>
        </div>
      ) : null}
      {asking ? (
        <ConfirmDialog
          isOpen title={`Mark ${missing} ${noun(missing)} as missing?`} confirmLabel="Mark as missing" onCancel={() => { setAsking(false); setError(''); }}
          onConfirm={async () => { await submit(); }}
          body={
            <>
              <p>Missing tubes are flagged for the dispatcher.</p>
              {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
            </>
          }
        />
      ) : null}
    </Drawer>
  );
}

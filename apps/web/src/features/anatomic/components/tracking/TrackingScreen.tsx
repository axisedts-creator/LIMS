'use client';
// 04-UI-UX §4.5 Tracking: lookup (BarcodeInput, scanner capture on) + [Basket mode] Switch. Single mode: result panel + movement Timeline (newest first, AC-06.2).
// Basket mode: DataTable of scanned blocks / slides + [Record movement] (Alt+V). Tabs: Lookup · Sent out. Labels travel in POST bodies only (REQ-SEC-098): never in a URL,
// router call or log. The basket is capped at 200 items (REQ-SEC-100). Users without anatomic.case.work get lookup only.
// LD-140 (2026-11-13, binding): kit components and token class names only; one primary button on the page ([Record movement]); statuses show tone, icon and word.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BarcodeInput, useScanCapture } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { IconButton } from '@lims/ui/components/IconButton';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import { getCaseForTrackingAction, listMovementsAction, lookupObjectAction } from '../../server/actions.material';
import type { BlockRow, CaseDetail, LocationStatus, Movement } from '../../server/types';
import { failText, LocationChip, partName, usePageShortcuts, When } from '../common';
import { MovementDialog, REASON_LABEL, type MovementDone, type MovementItem } from './MovementDialog';

const PAGE_ID = 'staff.anatomic.tracking';
const LABEL_PATTERN = /^[A-Z0-9-]{1,32}$/;
const BASKET_MAX = 200;
const MOVE_LABEL: Record<Movement['movement'], string> = { stored: 'Stored', retrieved: 'Retrieved', sent_out: 'Sent out', returned: 'Returned', discarded: 'Discarded' };
const NOT_FOUND = 'No block or slide with this label.';

export interface SentOutRow { block: BlockRow; destination?: string; reason?: string }
export type TrackingTab = 'lookup' | 'sent_out';

interface Found { id: string; label: string; kind: 'block' | 'slide'; status: LocationStatus; locationText?: string; caseId: string; accession: string; part: string; stain?: string }

/** label → lookup → case read → the block / slide row. The label itself is never kept in a URL or log. */
async function resolve(label: string): Promise<{ found: Found } | { error: string }> {
  const l = await lookupObjectAction(label);
  if (!l.ok) return { error: l.status === 404 ? NOT_FOUND : failText(l) };
  const { object_kind: kind, case_id: caseId } = l.data;
  const id = kind === 'block' ? l.data.block_id : kind === 'slide' ? l.data.slide_id : undefined;
  if (kind === 'case' || !id) return { error: 'This is a case label. Scan a block or slide label.' };
  const c = await getCaseForTrackingAction(caseId);
  if (!c.ok) return { error: failText(c) };
  const d: CaseDetail = c.data;
  const base = { caseId, accession: d.accession_no ?? '—', kind } as const;
  if (kind === 'block') {
    const b = d.blocks.find((x) => x.id === id);
    return b ? { found: { ...base, id, label: b.label, status: b.location_status, ...(b.location_text ? { locationText: b.location_text } : {}), part: partName(d.parts, b.part_id) } } : { error: NOT_FOUND };
  }
  const s = d.slides.find((x) => x.id === id);
  return s
    ? { found: { ...base, id, label: s.label, status: s.location_status, ...(s.location_text ? { locationText: s.location_text } : {}), part: partName(d.parts, s.part_id), stain: s.stain_display } }
    : { error: NOT_FOUND };
}

const movementText = (m: Movement) => {
  const where = m.location_text ?? m.destination_text;
  const why = m.reason_code ? ` (${REASON_LABEL[m.reason_code] ?? m.reason_code})` : '';
  return `${MOVE_LABEL[m.movement]}${where ? ` — ${where}` : ''}${why}`;
};

function Result({ f, movements }: { f: Found; movements: readonly Movement[] }) {
  const newest = [...movements].sort((a, b) => b.at.localeCompare(a.at));
  const last = newest[0];
  return (
    <>
      <DescriptionList
        columns={2}
        items={[
          { term: 'Label', value: <span className="lims-mono">{f.label}</span> },
          { term: 'Type', value: f.kind === 'block' ? 'Block' : 'Slide' },
          { term: 'Case', value: <a className="lims-link" href={`/anatomic/cases/${f.caseId}`}>{f.accession}</a> },
          { term: 'Part', value: f.part },
          ...(f.stain ? [{ term: 'Stain', value: f.stain }] : []),
          { term: 'Current location', value: <LocationChip status={f.status} text={f.locationText} /> },
          { term: 'Last movement', value: last ? <>{MOVE_LABEL[last.movement]}, <When value={last.at} time /></> : '—' },
        ]}
      />
      <h2 className="lims-card-title">Movement history</h2>
      {newest.length ? <Timeline items={newest.map((m) => ({ at: m.at, label: movementText(m), actor: m.by_display_name }))} /> : <p className="lims-description">No movements recorded yet.</p>}
    </>
  );
}

function SentOut({ rows }: { rows: readonly SentOutRow[] }) {
  if (rows.length === 0) return <EmptyState title="Nothing is sent out" body="Blocks you send out appear here until they are returned." />;
  const oldestFirst = [...rows].sort((a, b) => (a.block.last_movement_at ?? '').localeCompare(b.block.last_movement_at ?? ''));
  return (
    <DataTable
      caption="Blocks sent out"
      density="compact"
      rows={oldestFirst}
      getRowId={(r) => r.block.id}
      emptyState={{ title: 'Nothing is sent out' }}
      columns={[
        { id: 'label', header: 'Label', isRowHeader: true, cell: (r) => <span className="lims-mono">{r.block.label}</span> },
        { id: 'case', header: 'Case', cell: (r) => <a className="lims-link" href={`/anatomic/cases/${r.block.case_id}`}>{r.block.accession_no}</a> },
        { id: 'to', header: 'Sent to', cell: (r) => r.destination ?? '—' },
        { id: 'since', header: 'Since', cell: (r) => <When value={r.block.last_movement_at} time /> },
        { id: 'reason', header: 'Reason', cell: (r) => (r.reason ? (REASON_LABEL[r.reason] ?? r.reason) : '—') },
      ]}
    />
  );
}

export function TrackingScreen({ tab, canWork, sentOut }: { tab: TrackingTab; canWork: boolean; sentOut: readonly SentOutRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [basketMode, setBasketMode] = useState(false);
  const [basket, setBasket] = useState<readonly Found[]>([]);
  const [single, setSingle] = useState<{ found: Found; movements: readonly Movement[] }>();
  const [message, setMessage] = useState<string>();
  const [moving, setMoving] = useState(false);
  const [mfa, setMfa] = useState(false);
  const latest = useRef(0);

  const onScan = async (label: string) => {
    const mine = ++latest.current;
    setMessage(undefined);
    const r = await resolve(label);
    if (mine !== latest.current) return; // a newer scan owns the screen
    if ('error' in r) {
      setSingle(undefined);
      return setMessage(r.error);
    }
    const { found } = r;
    if (basketMode && canWork) {
      if (basket.some((b) => b.id === found.id)) return setMessage('Already in the list.');
      if (basket.length >= BASKET_MAX) return setMessage(`The basket is full (${BASKET_MAX} items). Record the movement first.`);
      return setBasket((b) => (b.some((x) => x.id === found.id) ? b : [...b, found]));
    }
    const m = await listMovementsAction(found.kind, found.id);
    if (mine !== latest.current) return;
    setSingle({ found, movements: m.ok ? m.data : [] });
  };

  useScanCapture({ onScan: (v) => void onScan(v), enabled: tab === 'lookup' && !moving, pattern: LABEL_PATTERN });

  const items: MovementItem[] = basket.map((b) => ({ id: b.id, label: b.label, kind: b.kind }));
  const openMovement = () => {
    if (canWork && basketMode && basket.length > 0) setMoving(true);
  };
  usePageShortcuts(PAGE_ID, canWork ? [{ key: 'Alt+V', description: 'Record movement for the basket', run: openMovement }] : [], [canWork, basketMode, basket.length]);

  const done = ({ recorded, failed }: MovementDone) => {
    setMoving(false);
    const keep = new Set(failed.map((f) => f.id));
    setBasket((b) => b.filter((x) => keep.has(x.id)));
    if (recorded) toast.show({ tone: 'success', title: `${recorded} recorded` });
    if (failed.length) toast.show({ tone: 'warning', title: `${failed.length} not recorded`, description: failed.map((f) => `${f.label}: that step isn't possible in its current state`).join('; ') });
  };

  const toggle = (on: boolean) => {
    setBasketMode(on);
    setMessage(undefined);
    setSingle(undefined);
  };

  return (
    <>
      <PageHeader title="Block & slide tracking" helpKey="anatomic.tracking" breadcrumbs={[{ label: 'Pathology cases', href: '/anatomic' }, { label: 'Block & slide tracking' }]} />
      <Tabs
        aria-label="Tracking sections"
        items={[{ id: 'lookup', label: 'Lookup' }, { id: 'sent_out', label: 'Sent out' }]}
        selectedId={tab}
        onChange={(id) => router.push(id === 'sent_out' ? '/anatomic/tracking?tab=sent_out' : '/anatomic/tracking')}
      >
        {tab === 'sent_out' ? (
          <SentOut rows={sentOut} />
        ) : (
          <>
            <BarcodeInput label="Scan or type a block or slide label" name="label" pattern={LABEL_PATTERN} submitKeys={['Enter', 'Tab']} clearAfterScan allowManual onScan={(v) => void onScan(v)} />
            {canWork ? <Switch label="Basket mode" isSelected={basketMode} onChange={toggle} /> : null}
            {message ? <p role="status" className="lims-description">{message}</p> : null}
            {basketMode && canWork ? (
              <>
                <DataTable
                  caption="Basket"
                  density="compact"
                  rows={basket}
                  getRowId={(r) => r.id}
                  emptyState={{ title: 'The basket is empty', body: 'Scan a block or slide label to add it.' }}
                  columns={[
                    { id: 'label', header: 'Label', isRowHeader: true, cell: (r) => <span className="lims-mono">{r.label}</span> },
                    { id: 'type', header: 'Type', cell: (r) => (r.kind === 'block' ? 'Block' : 'Slide') },
                    { id: 'loc', header: 'Current location', cell: (r) => <LocationChip status={r.status} text={r.locationText} /> },
                    { id: 'remove', header: 'Remove', align: 'end', cell: (r) => <IconButton label={`Remove ${r.label}`} icon="close" onPress={() => { setBasket((b) => b.filter((x) => x.id !== r.id)); setMessage(undefined); }} /> },
                  ]}
                />
                <Button variant="primary" isDisabled={basket.length === 0} shortcut="Alt+V" onPress={openMovement}>Record movement</Button>
              </>
            ) : single ? (
              <Result f={single.found} movements={single.movements} />
            ) : null}
          </>
        )}
      </Tabs>
      {canWork ? <MovementDialog items={items} isOpen={moving} onClose={() => setMoving(false)} onMfa={() => { setMoving(false); setMfa(true); }} onDone={done} /> : null}
      <Dialog
        title="Two-factor verification"
        size="sm"
        isOpen={mfa}
        onClose={() => setMfa(false)}
        footer={
          <>
            <Button variant="ghost" onPress={() => setMfa(false)}>Cancel</Button>
            {/* ponytail: no C2 step-up route is known (same as CaseWorkspace); reload lets the session guard redirect to it, then the user repeats the action. */}
            <Button variant="primary" onPress={() => window.location.reload()}>Verify now</Button>
          </>
        }
      >
        <p>This action needs two-factor verification.</p>
      </Dialog>
    </>
  );
}

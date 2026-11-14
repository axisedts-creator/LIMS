'use client';
// 04-UI-UX §4.6 Batch detail: DescriptionList header → scan field (BarcodeInput) → plate-style position grid (Cards, 12 columns; a capacity that is not a multiple of 12
// leaves the last row partial) → [Remove selected] → [Close batch] (ConfirmDialog). AC-11.4: scanning an accession number adds the case at the next free position, or at the
// empty position chosen first; AC-11.5: a closed batch is read-only (no scan field, no ticks, no buttons).
// The scanned value travels in POST bodies only, never in a URL, router call or log (C0 §2.4 rule 6, REQ-SEC-098). A member whose accession number the API withheld
// (centre restriction, 07-SECURITY) shows "Restricted"; its case id is never displayed and never invented: removal uses the case_id the API sent. Positions are rendered
// from the one batch read; there are no per-cell case reads.
// LD-140 (2026-11-13, binding): kit components and token class names only; [Close batch] is the page's one primary button; every status shows tone, icon and word.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { addBatchMembersAction, closeBatchAction, removeBatchMembersAction } from '../../server/actions.molecular';
import { lookupObjectAction } from '../../server/actions.material';
import type { BatchDetail, BatchMember } from '../../server/types';
import { newKey, When, type Fail, type Tone } from '../common';
import { batchFail, BatchStatusChip, MfaDialog } from './batch-shared';
import './molecular.css';

const SCAN_PATTERN = /^[A-Z0-9-]{1,32}$/;
const MSG = {
  full: 'This batch is full. There is no free position.',
  notFound: 'No pathology case with this accession number.',
  notCase: 'This is a block or slide label. Scan the accession number of a molecular case.',
  duplicate: 'This case is already in the batch.',
  failed: 'The scan failed. Try again.',
};

interface Notice { tone: Tone; text: string; reload?: boolean }

export function BatchDetailScreen({ batch, canWork }: { batch: BatchDetail; canWork: boolean }) {
  // Remounted when a refresh brings a new batch version: local additions / removals then come from the server.
  return <Body key={batch.version} batch={batch} canWork={canWork} />;
}

function Body({ batch, canWork }: { batch: BatchDetail; canWork: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = canWork && batch.status === 'open';
  const [added, setAdded] = useState<readonly BatchMember[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<number>();
  const [notice, setNotice] = useState<Notice>();
  const [removing, setRemoving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [mfa, setMfa] = useState(false);
  // Refs so a queue of fast scans always sees the positions the earlier scans took, and the newest version for If-Match.
  const taken = useRef<ReadonlyMap<number, string>>(new Map());
  const addedRef = useRef<readonly BatchMember[]>([]);
  const version = useRef(batch.version);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const members = [...batch.members.filter((m) => !removed.has(m.case_id)), ...added.filter((a) => !batch.members.some((m) => m.case_id === a.case_id))].sort((a, b) => a.position - b.position);
  const byPosition = new Map(members.map((m) => [m.position, m]));
  taken.current = new Map(members.map((m) => [m.position, m.case_id]));
  const positions = Array.from({ length: batch.capacity }, (_, i) => i + 1);

  const show = (f: Fail, position?: number) => {
    if (f.code === 'auth.mfa_required') return setMfa(true);
    const b = batchFail(f, position);
    setNotice({ tone: b.tone, text: b.text, reload: b.reload });
  };

  /** The chosen position when it is still free, else the lowest free one. */
  const isTaken = (n: number) => taken.current.has(n) || addedRef.current.some((m) => m.position === n);
  const nextPosition = () => (chosen !== undefined && !isTaken(chosen) && chosen <= batch.capacity ? chosen : positions.find((n) => !isTaken(n)));

  const scanOne = async (label: string) => {
    setNotice(undefined);
    const position = nextPosition();
    if (position === undefined) return setNotice({ tone: 'warning', text: MSG.full });
    const l = await lookupObjectAction(label);
    if (!l.ok) return l.status === 404 ? setNotice({ tone: 'warning', text: MSG.notFound }) : show(l);
    if (l.data.object_kind !== 'case') return setNotice({ tone: 'warning', text: MSG.notCase });
    const caseId = l.data.case_id;
    if (members.some((m) => m.case_id === caseId) || addedRef.current.some((m) => m.case_id === caseId)) return setNotice({ tone: 'warning', text: MSG.duplicate });
    const r = await addBatchMembersAction(batch.id, [{ case_id: caseId, position }], newKey());
    if (!r.ok) return show(r, position);
    version.current = r.data.version;
    addedRef.current = [...addedRef.current, { case_id: caseId, accession_no: label, position }];
    setAdded(addedRef.current);
    setChosen(undefined);
    router.refresh();
  };
  // One scan at a time, in order: a scanner can outrun the network and no scan may be dropped.
  const onScan = (label: string) => {
    queue.current = queue.current.then(() => scanOne(label)).catch(() => setNotice({ tone: 'danger', text: MSG.failed }));
  };

  const confirmRemove = async () => {
    const r = await removeBatchMembersAction(batch.id, version.current, [...selected], newKey());
    setRemoving(false);
    if (!r.ok) return show(r);
    version.current = r.data.version;
    setRemoved(new Set([...removed, ...selected]));
    setSelected(new Set());
    toast.show({ tone: 'success', title: 'Removed from batch' });
    router.refresh();
  };

  const confirmClose = async () => {
    const r = await closeBatchAction(batch.id, version.current, newKey());
    setClosing(false);
    if (!r.ok) return show(r);
    toast.show({ tone: 'success', title: 'Batch closed' });
    router.refresh();
  };

  const tick = (caseId: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(caseId); else n.delete(caseId); return n; });

  return (
    <>
      <PageHeader
        title={batch.batch_no}
        helpKey="anatomic.batch"
        breadcrumbs={[{ label: 'Pathology cases', href: '/anatomic' }, { label: 'Molecular batches', href: '/anatomic/batches' }, { label: batch.batch_no }]}
        status={<BatchStatusChip status={batch.status} />}
        actions={canEdit ? <Button variant="primary" onPress={() => setClosing(true)}>Close batch</Button> : null}
      />
      {notice ? (
        <div role="alert">
          <Banner tone={notice.tone} title={notice.text} {...(notice.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} />
        </div>
      ) : null}
      <DescriptionList
        columns={3}
        items={[
          { term: 'Batch number', value: <span className="lims-mono">{batch.batch_no}</span> },
          { term: 'Assay', value: <span className="lims-mono">{batch.assay_code}</span> },
          { term: 'Status', value: <BatchStatusChip status={batch.status} /> },
          { term: 'Kit name', value: batch.kit_name ?? '—' },
          { term: 'Kit lot', value: batch.kit_lot ?? '—' },
          { term: 'Kit expiry', value: <When value={batch.kit_expiry_on} /> },
          { term: 'Instrument', value: batch.instrument_text ?? '—' },
          { term: 'Run at', value: <When value={batch.run_at} time /> },
          { term: 'Members / capacity', value: `${members.length} / ${batch.capacity}` },
        ]}
      />
      {canEdit ? (
        <>
          <BarcodeInput label="Scan or type an accession number" name="accession_scan" pattern={SCAN_PATTERN} submitKeys={['Enter', 'Tab']} clearAfterScan allowManual onScan={onScan} />
          <p className="lims-description" role="status">
            {chosen !== undefined ? `The next scan goes to position ${chosen}.` : 'The next scan goes to the next free position, or choose an empty position first.'}
          </p>
          <Button isDisabled={selected.size === 0} onPress={() => setRemoving(true)}>Remove selected</Button>
        </>
      ) : null}
      {members.length === 0 ? <p className="lims-description">No samples in this batch yet.</p> : null}
      <ol className="lims-plate" aria-label="Batch positions">
        {positions.map((n) => {
          const m = byPosition.get(n);
          return (
            <li key={n} data-position={n} className={chosen === n ? 'lims-plate-cell lims-plate-chosen' : 'lims-plate-cell'}>
              <Card>
                <span className="lims-plate-pos">{n}</span>{' '}
                {m ? (
                  <>
                    {m.accession_no ? <a className="lims-link lims-mono" href={`/anatomic/cases/${m.case_id}`}>{m.accession_no}</a> : <span>Restricted</span>}
                    {canEdit ? <Checkbox label={m.accession_no ? `Select ${m.accession_no}` : `Select position ${n}`} isSelected={selected.has(m.case_id)} onChange={(on) => tick(m.case_id, on)} /> : null}
                  </>
                ) : canEdit ? (
                  <Button variant={chosen === n ? 'secondary' : 'ghost'} size="sm" onPress={() => setChosen(chosen === n ? undefined : n)}>{`Use position ${n}`}</Button>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ol>
      <ConfirmDialog
        title="Remove from batch"
        tone="danger"
        confirmLabel="Remove"
        isOpen={removing}
        onCancel={() => setRemoving(false)}
        body={`Remove ${selected.size} ${selected.size === 1 ? 'sample' : 'samples'} from this batch? Their positions become free.`}
        onConfirm={confirmRemove}
      />
      <ConfirmDialog
        title="Close batch"
        confirmLabel="Close batch"
        isOpen={closing}
        onCancel={() => setClosing(false)}
        body="Closing locks this batch. No samples can be added or removed afterwards."
        onConfirm={confirmClose}
      />
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}

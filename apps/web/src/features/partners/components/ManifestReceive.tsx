'use client';
// SM-2 Receive manifest (04-UI-UX §4, 03-APP-FLOW §2.1; US-06.1/.3/.5/.6/.7/.11). Scanning a partner reference ticks that line locally, nothing is written until
// "Confirm receipt" (SI3). Partner references are not lab barcodes: the pattern allows / . _ - and lower case, and the value never leaves the browser except as
// the matching line id. Failed lines offer Retry (SI4), Choose existing patient (C4 search, needs frontdesk.patient.read) and Mark not received (SI5).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { markLineNotReceivedAction, receiveManifestAction, retryLineAction, searchPatientsAction } from '../server/actions';
import type { ActionResult, Manifest, ManifestLine, PatientHit } from '../server/types';
import { Ad, Chip, DialogError, Notice, REASONS, errorText, failureText, hasPerm, orderHref } from './common';

type Outcome = 'received' | 'not_received';
type Pick = { outcome: Outcome; reason?: string };
const REF_PATTERN = /^[A-Za-z0-9_./-]{1,40}$/;
const OUTCOMES = [{ value: 'received', label: 'Received' }, { value: 'not_received', label: 'Not received' }] as const;
const reasonText = (code?: string) => REASONS.line_not_received_reasons.find((r) => r.code === code)?.display;
const note = (s?: string) => (s && s.length > 80 ? `${s.slice(0, 80)}…` : s);

function PatientDialog({ onClose, onPick }: { onClose: () => void; onPick: (p: PatientHit) => Promise<void> }) {
  const [hit, setHit] = useState<PatientHit>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly PatientHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setError(undefined); return; }
    let live = true; // drop stale responses when the query changes
    const t = setTimeout(async () => {
      const r = await searchPatientsAction(q);
      if (!live) return;
      setError(r.ok ? undefined : 'The patient search is not available right now. Try again.');
      setHits(r.ok ? r.data : []);
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  return (
    <Dialog
      title="Choose existing patient"
      isOpen
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button
            variant="primary"
            isDisabled={!hit}
            isLoading={busy}
            onPress={async () => {
              if (!hit) return;
              setBusy(true);
              try { await onPick(hit); } finally { setBusy(false); }
            }}
          >
            Use this patient
          </Button>
        </>
      }
    >
      {/* Ruling C13.T16 (C13 04-UI-UX:218): kit TextField + in-dialog results list, not a Combobox popover (LD-140). */}
      <TextField label="Search by name, code or phone" name="patient_query" maxLength={100} value={query} onChange={setQuery} />
      {hits.length ? (
        <RadioGroup<string>
          label="Results"
          name="patient_hit"
          options={hits.map((p) => ({ value: p.id, label: [p.full_name, p.patient_code, p.phone_masked, p.age_display].filter(Boolean).join(' · ') }))}
          value={hit?.id ?? ''}
          onChange={(id) => setHit(hits.find((p) => p.id === id))}
        />
      ) : null}
      <DialogError text={error} />
    </Dialog>
  );
}

export function ManifestReceive({ manifest, permissions }: { manifest: Manifest; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [picks, setPicks] = useState<Readonly<Record<string, Pick>>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [scanError, setScanError] = useState<string>();
  const [scanHint, setScanHint] = useState<string>();
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [searchFor, setSearchFor] = useState<ManifestLine | null>(null);
  const [notReceivedFor, setNotReceivedFor] = useState<ManifestLine | null>(null);
  const [noteFor, setNoteFor] = useState<ManifestLine | null>(null);
  const key = useRef(crypto.randomUUID());
  const canReceive = hasPerm(permissions, 'partners.manifest.receive');
  const canSearchPatients = hasPerm(permissions, 'frontdesk.patient.read');
  const receivable = (l: ManifestLine) => l.state === 'submitted';
  const entries = Object.entries(picks);
  const nReceived = entries.filter(([, p]) => p.outcome === 'received').length;
  const nNot = entries.length - nReceived;

  const update = (next: Record<string, Pick>) => { key.current = crypto.randomUUID(); setPicks(next); };
  const pick = (id: string, p: Pick) => { setRowErrors(({ [id]: _drop, ...rest }) => rest); update({ ...picks, [id]: p }); };
  const markSelected = () => {
    const ids = manifest.lines.filter((l) => receivable(l) && selected.has(l.id)).map((l) => l.id);
    if (ids.length) update({ ...picks, ...Object.fromEntries(ids.map((id) => [id, { outcome: 'received' as const }])) });
  };
  const onScan = (value: string) => {
    setScanHint(undefined);
    const line = manifest.lines.find((l) => l.partner_sample_ref?.toUpperCase() === value.toUpperCase());
    if (!line) return setScanError('No sample with this reference on this manifest.');
    if (!receivable(line)) return setScanError('This sample has already been handled.');
    setScanError(undefined);
    if (picks[line.id]?.outcome === 'received') return setScanHint('Already ticked');
    pick(line.id, { outcome: 'received' });
  };

  const settle = (r: ActionResult<unknown>, ok: string) => {
    if (r.ok) { setNotice(undefined); toast.show({ tone: 'success', title: ok }); router.refresh(); } else setNotice(errorText(r.code, r.status));
  };
  const receive = async () => {
    const missing = Object.fromEntries(entries.filter(([, p]) => p.outcome === 'not_received' && !p.reason).map(([id]) => [id, 'Choose a reason.']));
    if (Object.keys(missing).length) { setConfirming(false); setRowErrors(missing); return; }
    const lines = entries.map(([line_id, p]) => ({ line_id, outcome: p.outcome, ...(p.reason ? { reason_code: p.reason } : {}) }));
    const r = await receiveManifestAction(manifest.id, manifest.version, lines, key.current);
    setConfirming(false);
    if (r.ok) { setPicks({}); setSelected(new Set()); setRowErrors({}); settle(r, 'Receipt confirmed.'); return; }
    setNotice(errorText(r.code, r.status));
    const bad = Object.fromEntries((r.errors ?? []).flatMap((e) => { const i = /^\/lines\/(\d+)/.exec(e.path)?.[1]; const id = i === undefined ? undefined : lines[Number(i)]?.line_id; return id ? [[id, 'This sample could not be received.']] : []; }));
    setRowErrors(bad);
  };
  const openConfirm = () => { if (canReceive && entries.length) setConfirming(true); };
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'a') { e.preventDefault(); markSelected(); } else if (k === 'r') { e.preventDefault(); openConfirm(); }
  };

  const columns: ColumnDef<ManifestLine>[] = [
    { id: 'ref', header: 'Reference', isRowHeader: true, cell: (l) => <span className="lims-mono">{l.partner_sample_ref ?? '—'}</span> },
    { id: 'patient', header: 'Patient', cell: (l) => <><span>{l.patient.full_name}</span> <span className="lims-description">{[l.patient.sex, l.patient.age_years !== undefined ? `${l.patient.age_years} y` : undefined].filter(Boolean).join(', ')}</span></> },
    { id: 'tests', header: 'Tests', cell: (l) => <ul>{l.orderables.map((o) => <li key={o.orderable_id}>{`${o.code} · ${o.name}`}</li>)}</ul> },
    { id: 'priority', header: 'Priority', cell: (l) => <Badge tone={l.priority === 'urgent' ? 'warning' : 'neutral'}>{l.priority === 'urgent' ? 'Urgent' : 'Routine'}</Badge> },
    { id: 'collected', header: 'Collected', cell: (l) => (l.collected_at ? <Ad value={l.collected_at} withTime /> : '—') },
    {
      id: 'doctor', header: 'Doctor and note',
      cell: (l) => (
        <>
          {/* "Not confirmed" badge omitted: ManifestLine.referrer has no mapping state (see .orchestra/cr/C13.T16.md). */}
          {l.referrer ? <span>{l.referrer.display_name}</span> : null}
          {l.clinical_note ? <p className="lims-description">{note(l.clinical_note)}</p> : null}
          {l.clinical_note && l.clinical_note.length > 80 ? <Button size="sm" variant="ghost" onPress={() => setNoteFor(l)}>Show note</Button> : null}
        </>
      ),
    },
    { id: 'outcome', header: 'Outcome', cell: (l) => renderOutcome(l) },
  ];

  // Called as a function (not a component) so the radios keep their identity and focus across renders.
  function renderOutcome(line: ManifestLine) {
    const p = picks[line.id];
    if (receivable(line) && canReceive) {
      return (
        <>
          <RadioGroup<Outcome> label="Outcome" name={`outcome-${line.id}`} orientation="horizontal" options={OUTCOMES} value={(p?.outcome ?? '') as Outcome} onChange={(v) => pick(line.id, v === 'received' ? { outcome: v } : { outcome: v, ...(p?.reason ? { reason: p.reason } : {}) })} />
          {p?.outcome === 'not_received' ? (
            <CodedSelect label="Reason" name={`reason-${line.id}`} codedSet="partners.line_not_received_reasons" options={REASONS.line_not_received_reasons} {...(p.reason ? { value: p.reason } : {})} {...(rowErrors[line.id] ? { error: rowErrors[line.id] } : {})} onChange={(c) => pick(line.id, { outcome: 'not_received', reason: c })} />
          ) : null}
          {!p && rowErrors[line.id] ? <p className="lims-error">{rowErrors[line.id]}</p> : null}
        </>
      );
    }
    return (
      <>
        <Chip code={line.state} />
        {line.state === 'conversion_failed' ? (
          <>
            <p>{failureText(line.failure?.code)}</p>
            {canReceive ? (
              <>
                <Button size="sm" onPress={async () => settle(await retryLineAction(line.id, line.version, undefined, crypto.randomUUID()), 'Registration retried.')}>Retry</Button>
                {canSearchPatients ? <Button size="sm" onPress={() => setSearchFor(line)}>Choose existing patient</Button> : null}
                <Button size="sm" variant="ghost" onPress={() => setNotReceivedFor(line)}>Mark not received</Button>
              </>
            ) : null}
          </>
        ) : null}
        {line.state === 'not_received' && reasonText(line.not_received_reason_code) ? <p className="lims-description">{reasonText(line.not_received_reason_code)}</p> : null}
        {line.state === 'not_received' && line.order ? <p>Cancel or recollect in Front desk</p> : null}
        {line.order ? <a className="lims-link lims-mono" href={orderHref(line.order.order_id)}>{line.order.registration_no}</a> : null}
        {rowErrors[line.id] ? <p className="lims-error">{rowErrors[line.id]}</p> : null}
      </>
    );
  }

  return (
    <section aria-label="Receive manifest" onKeyDownCapture={onKeyDownCapture}>
      <PageHeader
        title={`Manifest ${manifest.manifest_no}`}
        helpKey="partners.manifest"
        breadcrumbs={[{ label: 'Partners', href: '/partners' }, { label: 'Manifests', href: '/partners/manifests' }, { label: manifest.manifest_no }]}
        status={<Chip code={manifest.state} />}
        actions={canReceive ? <Button variant="primary" shortcut="Alt+R" isDisabled={entries.length === 0} onPress={openConfirm}>Confirm receipt</Button> : null}
      />
      {manifest.partner.status === 'suspended' ? <Banner tone="warning" title="This partner is suspended. You can still receive samples already submitted." /> : null}
      {notice ? <Notice text={notice} /> : null}
      <DescriptionList
        columns={2}
        items={[
          { term: 'Manifest', value: <span className="lims-mono">{manifest.manifest_no}</span> },
          { term: 'Partner', value: `${manifest.partner.name} (${manifest.partner.partner_code})` },
          { term: 'Receiving centre', value: manifest.receiving_centre.name },
          { term: 'Collected on', value: manifest.collected_on ? <Ad value={manifest.collected_on} /> : '—' },
          { term: 'Submitted', value: manifest.submitted_at ? <Ad value={manifest.submitted_at} withTime /> : '—' },
          { term: 'Partner notes', value: manifest.notes ?? '—' },
        ]}
      />
      {canReceive ? (
        <>
          <BarcodeInput label="Scan or type the partner's sample reference" name="partner_sample_ref" pattern={REF_PATTERN} allowManual {...(scanError ? { error: scanError } : {})} onScan={onScan} />
          {scanHint ? <p className="lims-description" aria-live="polite">{scanHint}</p> : null}
          <Button isDisabled={selected.size === 0} shortcut="Alt+A" onPress={markSelected}>Mark selected as received</Button>
        </>
      ) : null}
      <DataTable
        caption="Samples on this manifest"
        columns={columns}
        rows={manifest.lines}
        getRowId={(l) => l.id}
        emptyState={{ title: 'No samples on this manifest' }}
        {...(canReceive ? { selection: { mode: 'multiple' as const, selectedIds: selected, onChange: setSelected } } : {})}
      />

      <ConfirmDialog
        title="Confirm receipt"
        isOpen={confirming}
        confirmLabel="Confirm"
        onCancel={() => setConfirming(false)}
        body={<p>{`Confirm ${nReceived} received and ${nNot} not received? Orders will be created for the received samples.`}</p>}
        onConfirm={receive}
      />
      {/* D-102 (C13 04-UI-UX:214): full clinical note in a row Drawer. */}
      <Drawer title={`Note for ${noteFor?.partner_sample_ref ?? `line ${noteFor?.line_no ?? ''}`}`} isOpen={noteFor !== null} onClose={() => setNoteFor(null)}>
        <p>{noteFor?.clinical_note}</p>
      </Drawer>
      {searchFor ? (
        <PatientDialog
          onClose={() => setSearchFor(null)}
          onPick={async (p) => {
            const line = searchFor;
            const r = await retryLineAction(line.id, line.version, p.id, crypto.randomUUID());
            setSearchFor(null);
            settle(r, 'Registration retried.');
          }}
        />
      ) : null}
      <ConfirmDialog
        key={notReceivedFor?.id ?? 'none'}
        title="Mark not received"
        isOpen={notReceivedFor !== null}
        confirmLabel="Mark not received"
        onCancel={() => setNotReceivedFor(null)}
        body={<p>This sample did not arrive in a usable state. No order is created for it.</p>}
        requireReason={{ codedSet: 'partners.line_not_received_reasons', options: REASONS.line_not_received_reasons }}
        onConfirm={async ({ reasonCode }) => {
          const line = notReceivedFor;
          if (!line || !reasonCode) return;
          setNotReceivedFor(null);
          settle(await markLineNotReceivedAction(line.id, line.version, reasonCode), 'Marked as not received.');
        }}
      />
    </section>
  );
}

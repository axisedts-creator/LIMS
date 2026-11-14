'use client';
// SCR-10 Message detail (04-UI-UX §3): metadata, runs, records of the latest run, raw drawer (on demand), attachment card, reprocess and re-match.
// Reprocess / re-match are a UI hint (instruments.message.rematch); the API enforces. The page never loads the raw text: only "Show raw" does.
import { useEffect, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Timeline } from '@lims/ui/components/Timeline';
import { shortcuts } from '@/core/shortcuts/registry';
import { getInstrumentMessageAction } from '../server/actions';
import { REPROCESS_REASONS, type MessageDetailDto, type MessageRecord } from '../server/messages';
import { EXCEPTION_HINT, KIND_LABEL, MappingChip, OutcomeChip, ScanChip, emitLabel, exceptionHint, portOutcomeText, sizeText } from './MessageLabels';
import { RawMessageDrawer } from './RawMessageDrawer';
import { RematchDialog } from './RematchDialog';
import { ReprocessDialog } from './ReprocessDialog';
import { hasPerm } from './labels';

const REMATCH = 'instruments.message.rematch';
const REPROCESSABLE = ['quarantined', 'shadow', 'parsed']; // AC-19.1
const REMATCH_CLASSES = ['patient', 'attachment'];
const EXPIRED = 'Parsed rows older than 90 days are not kept. Show a preview parse of the original message.';
const when = (v: string | undefined) => (v ? <DateText value={v as never} withTime /> : '—');
const reasonDisplay = (c: string) => REPROCESS_REASONS.find((r) => r.code === c)?.display ?? c;

export function MessageDetail({ message: m, permissions }: { message: MessageDetailDto; permissions: readonly string[] }) {
  const [raw, setRaw] = useState(false);
  const [reprocess, setReprocess] = useState(false);
  const [rematch, setRematch] = useState<MessageRecord>();
  const [preview, setPreview] = useState<readonly MessageRecord[]>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const canRematch = hasPerm(permissions, REMATCH);
  const outcome = m.latest_run?.outcome;
  const canReprocess = canRematch && m.message_kind !== 'host_query' && !!outcome && REPROCESSABLE.includes(outcome);
  const records = preview ?? m.records;

  // 04-UI-UX §4: SCR-10 Alt+R Show raw; Alt+P Reprocess only with instruments.message.rematch.
  useEffect(
    () => shortcuts.register('staff.instruments.message', { key: 'Alt+R', description: 'Show raw', run: () => setRaw(true) }, ...(canRematch ? [{ key: 'Alt+P', description: 'Reprocess', run: () => { if (canReprocess) setReprocess(true); } }] : [])),
    [canRematch, canReprocess],
  );

  const showPreview = async () => {
    setLoadingPreview(true);
    setPreviewFailed(false);
    const r = await getInstrumentMessageAction(m.id, { previewParse: true });
    if (r.ok) setPreview(r.data.records);
    else setPreviewFailed(true);
    setLoadingPreview(false);
  };

  const columns: ColumnDef<MessageRecord>[] = [
    { id: 'seq', header: '#', align: 'end', cell: (r) => r.record_seq },
    { id: 'class', header: 'Class', cell: (r) => r.record_class },
    { id: 'barcode', header: 'Barcode', isRowHeader: true, cell: (r) => (
      <>
        {r.sample_barcode ? <span className="lims-mono">{r.sample_barcode}</span> : '—'}
        {/* react-aria names a row by its row-header cell only: add the analyte code so QC rows (no barcode) are identifiable */}
        <span className="lims-visually-hidden"> {r.instrument_analyte_code}</span>
      </>
    ) },
    { id: 'code', header: 'Code', cell: (r) => r.instrument_analyte_code ?? '—' },
    { id: 'value', header: 'Value', cell: (r) => r.value_raw ?? '—' },
    { id: 'unit', header: 'Unit', cell: (r) => r.unit_raw ?? '—' },
    { id: 'flags', header: 'Flags', cell: (r) => (r.instrument_flags?.length ? r.instrument_flags.join(' ') : '—') },
    { id: 'result_at', header: 'Result time', cell: (r) => when(r.result_at) },
    { id: 'mapping', header: 'Mapping', cell: (r) => <MappingChip status={r.mapping_status} /> },
    { id: 'emit', header: 'Emit status', cell: (r) => emitLabel(r.emit_status) },
    {
      id: 'outcome',
      header: 'Lab outcome',
      cell: (r) => (
        <>
          {portOutcomeText(r)}
          {exceptionHint(r) ? <span className="lims-description"> {EXCEPTION_HINT}</span> : null}
        </>
      ),
    },
    { id: 'event', header: 'Event', cell: (r) => (r.event_id ? <IdText value={r.event_id} /> : '—') },
    {
      id: 'actions',
      header: 'Actions',
      cell: (r) => (canRematch && r.sample_barcode && REMATCH_CLASSES.includes(r.record_class) ? <Button size="sm" onPress={() => setRematch(r)}>Re-match…</Button> : null),
    },
  ];

  const att = m.attachment;
  return (
    <section aria-label="Message">
      <PageHeader
        title="Message"
        helpKey="instruments.messages"
        breadcrumbs={[{ label: 'Instruments', href: '/instruments/instruments' }, { label: 'Messages', href: '/instruments/messages' }, { label: m.instrument_code }]}
        status={
          <>
            <IdText value={m.id} truncate={12} /> <OutcomeChip outcome={outcome} />
          </>
        }
        actions={
          <>
            <Button onPress={() => setRaw(true)}>Show raw</Button>
            {canRematch ? <Button variant="primary" isDisabled={!canReprocess} onPress={() => setReprocess(true)}>Reprocess</Button> : null}
          </>
        }
      />
      <DescriptionList
        columns={3}
        items={[
          { term: 'Instrument', value: m.instrument_code },
          { term: 'Agent', value: <IdText value={m.agent_id} /> },
          { term: 'Protocol', value: m.protocol },
          { term: 'Kind', value: KIND_LABEL[m.message_kind] ?? m.message_kind },
          { term: 'Control id', value: m.message_control_id ?? '—' },
          { term: 'Message key kind', value: m.message_key_kind ?? '—' },
          { term: 'Received (server)', value: when(m.received_at) },
          { term: 'Captured (corrected)', value: when(m.captured_at) },
          { term: 'Size', value: sizeText(m.size_bytes) },
          { term: 'SHA-256', value: m.raw_sha256 ? <IdText value={m.raw_sha256} truncate={12} /> : '—' },
          { term: 'Warnings', value: m.warnings.length ? m.warnings.join(', ') : '—' },
        ]}
      />

      {att ? (
        <section aria-label="Attachment">
          <h2>Attachment</h2>
          <DescriptionList
            columns={3}
            items={[
              { term: 'File name', value: att.original_file_name ?? '—' },
              { term: 'Type', value: att.mime_type },
              { term: 'Size', value: sizeText(att.size_bytes) },
              { term: 'Scan', value: <ScanChip state={att.scan_state} /> },
            ]}
          />
          {/* AC-12.6: a same-origin link to the streaming route — the browser downloads through the BFF; no Storage URL ever reaches the page. Clean files only. */}
          {att.scan_state === 'clean' ? <a className="lims-link" href={`/instruments/messages/${m.id}/attachment`}>Open</a> : null}
        </section>
      ) : null}

      <section aria-label="Runs">
        <h2>Runs</h2>
        <Timeline
          items={m.runs.map((r) => ({
            at: r.created_at,
            label: `Run ${r.run_no} · ${r.kind} · ${r.outcome} · ${r.patient_records + r.qc_records + r.calibrator_records} records · ${r.emitted_events} events${r.reason_code ? ` · ${reasonDisplay(r.reason_code)}` : ''}`,
            actor: r.actor_display ?? r.actor_type,
          }))}
        />
      </section>

      <section aria-label="Records">
        <h2>Records</h2>
        {m.records_expired && !preview ? (
          <>
            <Banner tone="info" title={EXPIRED} />
            <Button isLoading={loadingPreview} onPress={() => void showPreview()}>Preview parse</Button>
            {previewFailed ? (
              <div role="alert">
                <Banner tone="danger" title="The preview could not be loaded." />
              </div>
            ) : null}
          </>
        ) : null}
        <DataTable caption="Records" columns={columns} rows={records} getRowId={(r) => r.id} emptyState={{ title: 'This message has no result records.' }} />
      </section>

      {raw ? <RawMessageDrawer messageId={m.id} onClose={() => setRaw(false)} /> : null}
      {reprocess ? <ReprocessDialog messageId={m.id} onClose={() => setReprocess(false)} /> : null}
      {rematch ? <RematchDialog record={rematch} onClose={() => setRematch(undefined)} /> : null}
    </section>
  );
}

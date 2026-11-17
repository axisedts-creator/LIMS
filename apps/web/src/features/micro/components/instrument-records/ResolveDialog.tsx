'use client';
// 04-UI-UX §4 "Resolve conflict" (AC-08.6: use_instrument replaces the manual value, audited; keep_existing closes the record as ignored). M21 with { resolution }.
// LD-140 (2026-11-13): kit components only. Two columns "Instrument" (the record as received) and "Current" (the manual value read from the culture, GET /v1/micro/cultures/{id});
// nothing is pre-selected: overwriting a manual result is never the default. Instrument text is rendered as text only (REQ-SEC-121).
import { useEffect, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { useToast } from '@lims/ui/components/Toast';
import { useAttempt } from '../../forms/useAttempt';
import { applyInstrumentRecordAction, getCompareValuesAction } from '../../server/instrumentRecordActions';
import type { CompareIsolate, InstrumentRecordDto, RecordResolution } from '../../server/types';
import { FailNotice } from '../common';

const CONFLICT = 'This record conflicts with existing data. Choose which value to keep.'; // §10 micro.instrument_record_conflict
const NOT_ASSIGNED = 'This record is not assigned to a culture yet, so there is nothing to compare. Assign it to a culture first.';
const NO_CURRENT = "The current value could not be loaded. You can still choose, but check the culture first if you are unsure.";

interface Line { id: string; item: string; instrument: string; current: string }
const dash = (v: string | undefined) => v || '—';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** Instrument vs current lines for the record's isolate; "—" where a side has no value. */
function lines(r: InstrumentRecordDto, isolates: CompareIsolate[]): Line[] {
  const iso = isolates.find((i) => i.isolate_seq === r.isolate_seq);
  if (r.record_kind === 'organism_id') {
    return [{ id: 'organism', item: 'Organism', instrument: dash(r.organism_code_raw), current: dash(iso?.organism_display ?? iso?.organism_code) }];
  }
  const wanted = r.antibiotic_code ?? (r.antibiotic_code_raw ? norm(r.antibiotic_code_raw) : undefined);
  const cur = iso?.ast.find((a) => a.antibiotic_code === wanted);
  const std = (s?: string, v?: string) => dash([s, v].filter(Boolean).join(' '));
  return [
    { id: 'antibiotic', item: 'Antibiotic', instrument: dash(r.antibiotic_code_raw), current: dash(cur?.antibiotic_display) },
    { id: 'value', item: 'Value', instrument: dash(r.raw_value), current: dash(cur?.raw_value) },
    { id: 'interpretation', item: 'Interpretation', instrument: dash(r.interpretation_raw), current: dash(cur?.category_code) },
    { id: 'standard', item: 'Standard', instrument: std(r.standard, r.standard_version), current: std(cur?.standard, cur?.standard_version) },
  ];
}

export interface ResolveDialogProps {
  record: InstrumentRecordDto;
  onClose: () => void;
  /** Called after the API accepted the resolution (the parent refreshes the page). */
  onSaved: () => void;
}

export function ResolveDialog({ record, onClose, onSaved }: ResolveDialogProps) {
  const toast = useToast();
  const { busy, fail, touch, send } = useAttempt();
  const [isolates, setIsolates] = useState<CompareIsolate[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [choice, setChoice] = useState<RecordResolution>();
  const [choiceError, setChoiceError] = useState<string>();
  const cultureId = record.culture_id;

  useEffect(() => {
    if (!cultureId) return;
    let alive = true;
    getCompareValuesAction(cultureId).then(
      (r) => { if (alive) (r.ok ? setIsolates(r.data) : setLoadFailed(true)); },
      () => { if (alive) setLoadFailed(true); },
    );
    return () => { alive = false; };
  }, [cultureId]);

  const submit = async () => {
    if (!choice) {
      setChoiceError('Choose which value to keep.');
      return;
    }
    const saved = await send((key) => applyInstrumentRecordAction(record.id, record.version, { resolution: choice }, key));
    if (!saved) return;
    toast.show({ tone: 'success', title: choice === 'use_instrument' ? 'Instrument value used' : 'Current value kept' });
    onSaved();
  };

  const columns: ColumnDef<Line>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (l) => l.item },
    { id: 'instrument', header: 'Instrument', cell: (l) => l.instrument },
    { id: 'current', header: 'Current', cell: (l) => (isolates || loadFailed ? l.current : '…') },
  ];

  return (
    <Dialog
      title="Resolve conflict"
      isOpen
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void submit()} isLoading={busy} isDisabled={!cultureId}>
            Resolve
          </Button>
        </>
      }
    >
      <FailNotice fail={fail?.code === 'micro.instrument_record_conflict' ? undefined : fail} /> {/* the paragraph below already says it */}
      <p>{CONFLICT}</p>
      {cultureId ? (
        <>
          {loadFailed ? <Banner tone="warning" title={NO_CURRENT} /> : null}
          <DataTable<Line> caption="Instrument value and current value" density="compact" columns={columns} rows={lines(record, isolates ?? [])} getRowId={(l) => l.id} emptyState={{ title: 'Nothing to compare.' }} />
          <RadioGroup<RecordResolution>
            label="Resolution"
            name="resolution"
            isRequired
            options={[
              { value: 'use_instrument', label: 'Use instrument value' },
              { value: 'keep_existing', label: 'Keep current value' },
            ]}
            {...(choiceError ? { error: choiceError } : {})}
            onChange={(v) => {
              setChoice(v);
              setChoiceError(undefined);
              touch();
            }}
          />
        </>
      ) : (
        <Banner tone="info" title={NOT_ASSIGNED} />
      )}
    </Dialog>
  );
}

'use client';
// 04-UI-UX §4 "Assign to culture" (AC-08.4: a record waiting for a match is assigned by the user; M20). LD-140 (2026-11-13): kit components only.
// The user scans the SPECIMEN barcode (the scan is the check that the right tube is in hand: the record's own barcode is not pre-filled), the BFF looks the specimen up
// (C5) and lists its live cultures, the user picks one and confirms the isolate number (1..99, default = the record's). AC-08.10 / REQ-SEC-098: the value goes to the server action only.
// S-02: unknown barcode, no culture and a refused lookup show one text. The Idempotency-Key survives a retry and changes when a value changes (useAttempt).
import { useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { useAttempt } from '../../forms/useAttempt';
import { assignInstrumentRecordAction, findCulturesForAssignAction } from '../../server/instrumentRecordActions';
import type { InstrumentRecordDto, ScannedCulture } from '../../server/types';
import { FailNotice } from '../common';
import { CULTURE_STATUS } from '../worklist/CultureStatusChip';

const NO_CULTURE = 'No microbiology culture for this specimen.';
const SCAN_FAILED = "We couldn't look that up. Try again.";
const statusWord = (s: string) => (Object.hasOwn(CULTURE_STATUS, s) ? CULTURE_STATUS[s]!.label : 'Unknown status');

export interface AssignDialogProps {
  record: InstrumentRecordDto;
  onClose: () => void;
  /** The saved record. The parent decides what follows (a conflict opens the conflict dialog). */
  onSaved: (r: InstrumentRecordDto) => void;
}

export function AssignDialog({ record, onClose, onSaved }: AssignDialogProps) {
  const toast = useToast();
  const { busy, fail, touch, send } = useAttempt();
  const scanning = useRef(false);
  const [cultures, setCultures] = useState<ScannedCulture[]>();
  const [notice, setNotice] = useState<'none' | 'error'>();
  const [cultureId, setCultureId] = useState<string>();
  const [isolate, setIsolate] = useState(record.isolate_seq === undefined ? '' : String(record.isolate_seq));
  const [isolateError, setIsolateError] = useState<string>();

  const onScan = async (value: string) => {
    if (scanning.current) return;
    scanning.current = true;
    setNotice(undefined);
    setCultures(undefined);
    setCultureId(undefined);
    touch();
    try {
      const r = await findCulturesForAssignAction(value);
      if (r.kind === 'list') setCultures(r.cultures);
      else setNotice(r.kind);
    } catch {
      setNotice('error');
    } finally {
      scanning.current = false;
    }
  };

  const submit = async () => {
    const seq = /^\d{1,2}$/.test(isolate.trim()) ? Number(isolate.trim()) : 0;
    if (seq < 1 || seq > 99) {
      setIsolateError('Enter an isolate number from 1 to 99.'); // AC-08.11
      return;
    }
    if (!cultureId) return;
    const saved = await send((key) => assignInstrumentRecordAction(record.id, record.version, { culture_id: cultureId, isolate_seq: seq }, key));
    if (!saved) return;
    if (saved.match_status !== 'conflict') toast.show({ tone: 'success', title: 'Record assigned to the culture' });
    onSaved(saved);
  };

  return (
    <Dialog
      title="Assign to culture"
      isOpen
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void submit()} isLoading={busy} isDisabled={!cultureId}>
            Assign
          </Button>
        </>
      }
    >
      <FailNotice fail={fail} />
      <BarcodeInput label="Scan specimen barcode" name="scan_barcode" onScan={(v) => void onScan(v)} />
      {notice === 'none' ? (
        <div role="status">
          <Banner tone="info" title={NO_CULTURE} />
        </div>
      ) : null}
      {notice === 'error' ? (
        <div role="alert">
          <Banner tone="danger" title={SCAN_FAILED} />
        </div>
      ) : null}
      {/* always present: it fills when the scan answers, so a fast user (or a scanner) can open it straight away */}
      <Select
        label="Culture"
        name="culture_id"
        isRequired
        options={(cultures ?? []).map((c) => ({ value: c.id, label: `${c.test_name} — ${statusWord(c.status)}` }))}
        {...(cultureId ? { value: cultureId } : {})}
        onChange={(v) => {
          setCultureId(v);
          touch();
        }}
      />
      <TextField
        label="Isolate no."
        name="isolate_seq"
        maxLength={3}
        inputMode="numeric"
        value={isolate}
        {...(isolateError ? { error: isolateError } : {})}
        onChange={(v) => {
          setIsolate(v);
          setIsolateError(undefined);
          touch();
        }}
      />
    </Dialog>
  );
}

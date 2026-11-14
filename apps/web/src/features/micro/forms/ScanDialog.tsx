'use client';
// Alt+B on the culture page (04-UI-UX §3 shortcut table): "Focus barcode scan (opens the scan dialog)". LD-140 (2026-11-13): kit components only.
// Same flow and same answers as the worklist scan (AC-02.2, S-02: one text for unknown barcode / no culture / refused lookup). REQ-SEC-098: the value goes to the server
// action only; it is never put into a URL, stored or logged, and the navigation carries the culture id only.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Dialog } from '@lims/ui/components/Dialog';
import { ChooseCultureDialog } from '../components/worklist/ChooseCultureDialog';
import { scanSpecimenAction } from '../server/lookupSpecimenByBarcode.server';
import type { ScanResult } from '../server/types';

const NO_CULTURE = 'No microbiology culture for this specimen.';
const SCAN_FAILED = "We couldn't look that up. Try again.";

export function ScanDialog({ currentCultureId, onClose }: { currentCultureId: string; onClose: () => void }) {
  const router = useRouter();
  const busy = useRef(false);
  const [notice, setNotice] = useState<'none' | 'error'>();
  const [choices, setChoices] = useState<Extract<ScanResult, { kind: 'choose' }>['cultures']>();

  const open = (id: string) => {
    if (id === currentCultureId) onClose();
    else router.push(`/micro/cultures/${id}`);
  };
  const onScan = async (value: string) => {
    if (busy.current) return;
    busy.current = true;
    setNotice(undefined);
    try {
      const r = await scanSpecimenAction(value);
      if (r.kind === 'open') open(r.cultureId);
      else if (r.kind === 'choose') setChoices(r.cultures);
      else setNotice(r.kind);
    } catch {
      setNotice('error');
    } finally {
      busy.current = false;
    }
  };

  if (choices) return <ChooseCultureDialog cultures={choices} onChoose={open} onClose={onClose} />;
  return (
    <Dialog title="Scan specimen barcode" isOpen onClose={onClose} size="sm">
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
    </Dialog>
  );
}

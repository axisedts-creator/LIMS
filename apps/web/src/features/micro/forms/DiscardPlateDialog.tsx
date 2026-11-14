'use client';
// 04-UI-UX §3.1 "Discard plate" (ConfirmDialog; AC-03.* UI side). LD-140 (2026-11-13): kit components only. If-Match = the plate's version; the server decides whether
// the plate can still be discarded (state / final lock) and the page refreshes afterwards.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice, type Fail } from '../components/common';
import { discardPlateAction } from '../server/cultureActions';
import type { PlateDto } from '../server/types';

export function DiscardPlateDialog({ cultureId, plate, onClose }: { cultureId: string; plate: PlateDto; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [fail, setFail] = useState<Fail>();
  return (
    <ConfirmDialog
      title={`Discard plate ${plate.plate_no}?`}
      tone="danger"
      confirmLabel="Discard"
      isOpen
      body={
        <>
          <FailNotice fail={fail} />
          <p>The plate stays in the record as discarded. It can no longer be read.</p>
        </>
      }
      onCancel={onClose}
      onConfirm={async () => {
        setFail(undefined);
        let r;
        try {
          r = await discardPlateAction(cultureId, plate.id, plate.version);
        } catch {
          setFail({ ok: false, status: 0, code: 'common.internal' });
          return;
        }
        if (!r.ok) {
          setFail(r);
          if (r.code === 'micro.culture_invalid_transition') router.refresh();
          return;
        }
        toast.show({ tone: 'success', title: `Plate ${plate.plate_no} discarded` });
        router.refresh();
        onClose();
      }}
    />
  );
}

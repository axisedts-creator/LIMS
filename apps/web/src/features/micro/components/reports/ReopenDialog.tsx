'use client';
// 04-UI-UX §3.4 "Reopen for amendment" (AC-11.1, AC-11.4 UI side; 07-SECURITY S-30): kit ConfirmDialog with a required Reason and optional Details (max 500). LD-140 (2026-11-13): kit components only.
// 08 A17 D-62: the reasons are C5's amendment_reasons (global + tenant) through the BFF, which removes module_phase_progression, module_preliminary_update and supplementary_report (C10 sends those itself);
// the dialog can only submit a code it listed. A failed reason list leaves an empty select and Reopen then sends nothing. If-Match = culture.version (M17); the dialog stays open with the choice kept on a refusal.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { listAmendmentReasonsAction, reopenCultureAction } from '../../server/reportActions';
import type { CultureDetailDto, LabCodeLite } from '../../server/types';
import type { Fail } from '../common';
import { ReportNotice } from './ReportNotice';

export function ReopenDialog({ culture, onClose }: { culture: CultureDetailDto; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [reasons, setReasons] = useState<LabCodeLite[]>();
  const [fail, setFail] = useState<Fail>();

  useEffect(() => {
    let alive = true;
    listAmendmentReasonsAction().then(
      (r) => { if (alive) setReasons(r); },
      () => { if (alive) setReasons([]); },
    );
    return () => { alive = false; };
  }, []);
  if (!reasons) return null;

  return (
    <ConfirmDialog
      title="Reopen for amendment"
      confirmLabel="Reopen"
      isOpen
      body={
        <>
          <ReportNotice fail={fail} />
          <p>The sent reports stay on record. Choose why this culture is being reopened.</p>
        </>
      }
      requireReason={{ codedSet: 'lab.amendment_reasons', options: reasons, freeText: { maxLength: 500, isRequired: false } }}
      onCancel={onClose}
      onConfirm={async ({ reasonCode, reasonText }) => {
        if (!reasonCode || !reasons.some((r) => r.code === reasonCode)) return; // only a code the dialog listed can be sent (D-62)
        setFail(undefined);
        let r;
        try {
          r = await reopenCultureAction(culture.id, culture.version, { amendment_reason_code: reasonCode, ...(reasonText?.trim() ? { amendment_reason_text: reasonText.trim() } : {}) });
        } catch {
          setFail({ ok: false, status: 0, code: 'common.internal' });
          return;
        }
        if (!r.ok) {
          setFail(r);
          return;
        }
        toast.show({ tone: 'success', title: 'Culture reopened for amendment' });
        router.refresh();
        onClose();
      }}
    />
  );
}

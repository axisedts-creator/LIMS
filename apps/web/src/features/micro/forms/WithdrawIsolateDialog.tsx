'use client';
// 04-UI-UX §3.3 "Withdraw isolate {n}?" (AC-05.4): kit ConfirmDialog tone="danger" with a coded reason (micro.isolate_withdraw_reasons, required) and an optional comment
// up to 500 characters. LD-140 (2026-11-13): kit components only. The dialog opens once the reasons are loaded; If-Match = the isolate's version.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice, type Fail } from '../components/common';
import { withdrawIsolateAction } from '../server/cultureActions';
import type { IsolateDto } from '../server/types';
import { useCodes } from './useCodes';

export function WithdrawIsolateDialog({ isolate, onClose }: { isolate: IsolateDto; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const reasons = useCodes('isolate_withdraw_reasons');
  const [fail, setFail] = useState<Fail>();
  if (!reasons.loaded) return null;

  return (
    <ConfirmDialog
      title={`Withdraw isolate ${isolate.isolate_seq}?`}
      tone="danger"
      confirmLabel="Withdraw"
      isOpen
      body={
        <>
          <FailNotice fail={fail} />
          <p>The isolate stays in the record as withdrawn and is left out of reports.</p>
        </>
      }
      requireReason={{ codedSet: 'micro.isolate_withdraw_reasons', options: reasons.rows.filter((r) => r.is_active).map((r) => ({ code: r.code, display: r.display })), freeText: { maxLength: 500, isRequired: false } }}
      onCancel={onClose}
      onConfirm={async ({ reasonCode, reasonText }) => {
        if (!reasonCode) return;
        setFail(undefined);
        let r;
        try {
          r = await withdrawIsolateAction(isolate.id, isolate.version, { reason_code: reasonCode, ...(reasonText?.trim() ? { comment: reasonText.trim() } : {}) });
        } catch {
          setFail({ ok: false, status: 0, code: 'common.internal' });
          return;
        }
        if (!r.ok) {
          setFail(r);
          if (r.code === 'micro.culture_invalid_transition') router.refresh();
          return;
        }
        toast.show({ tone: 'success', title: `Isolate ${isolate.isolate_seq} withdrawn` });
        router.refresh();
        onClose();
      }}
    />
  );
}

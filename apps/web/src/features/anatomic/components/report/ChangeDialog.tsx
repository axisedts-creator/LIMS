'use client';
// 04-UI-UX §4.2.7 Change dialog (R4, 08 A17 D-62): [Revise] while no C5 result of the primary items is approved, [Amend] once one is (AC-10.1, AC-10.2). The reason comes from the
// C5 coded set amendment_reasons (active only, system codes removed by the BFF); Details is optional (<= 500). Privileged (anatomic.case.signout at aal2): a step-up is handled
// by the page. LD-140 (2026-11-13, binding): kit ConfirmDialog (requireReason) only; the confirm button is the one primary button of the open dialog.
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { startChangeAction } from '../../server/actions.report';
import type { ReasonOption } from '../../server/report.types';
import type { CaseDetail } from '../../server/types';
import { newKey, type Fail } from '../common';

/** AC-10.2: any approved ACTIVE primary item makes it an amendment; add-on items do not count; no lab.result.read (status absent) = revision, the server decides again (E10). */
export const isAmendment = (detail: CaseDetail) => detail.items.some((i) => i.role === 'primary' && i.is_active && i.lab_status === 'approved');

export function ChangeDialog({ detail, reasons, reasonsFailed, isOpen, onClose, onFail, onMfa }: {
  detail: CaseDetail; reasons: readonly ReasonOption[]; reasonsFailed: boolean; isOpen: boolean; onClose: () => void; onFail: (f: Fail) => void; onMfa: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const amend = isAmendment(detail);
  const confirm = async ({ reasonCode, reasonText }: { reasonCode?: string; reasonText?: string }) => {
    const r = await startChangeAction(detail.id, detail.version, { reason_code: reasonCode ?? '', ...(reasonText ? { reason_text: reasonText } : {}) }, newKey());
    onClose();
    if (r.ok) {
      toast.show({ tone: 'success', title: amend ? 'Amendment started' : 'Revision started' });
      router.refresh();
    } else if (r.code === 'auth.mfa_required') onMfa();
    else onFail(r);
  };
  return (
    <ConfirmDialog
      title={amend ? 'Amend approved report' : 'Revise report'}
      confirmLabel={amend ? 'Amend' : 'Revise'}
      isOpen={isOpen}
      onCancel={onClose}
      body={
        <>
          <p>{amend ? 'This result is approved. Your change creates an amended report; the previous version stays on record.' : 'Your change creates a revision of this report; the previous version stays on record.'}</p>
          {reasonsFailed ? <p className="lims-error">The list of reasons could not be loaded. Close this dialog and try again.</p> : null}
        </>
      }
      requireReason={{ codedSet: 'lab.amendment_reasons', options: reasons, freeText: { maxLength: 500, isRequired: false } }}
      onConfirm={confirm}
    />
  );
}

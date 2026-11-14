'use client';
// Shared reason-coded ConfirmDialog for Cancel (H6) and Unassign (H4). Coded sets come from the API (H20). "requires_text" reasons need details.
import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { failText } from '../labels';
import type { ActionResult } from '../server/actions';
import { useSubmissionKey } from '../submission';
import type { CodedValue } from '../types';

export interface ReasonConfirmProps {
  title: string;
  confirmLabel: string;
  codedSet: string;
  reasons: readonly CodedValue[];
  body: ReactNode;
  doneTitle: string;
  tone?: 'default' | 'danger';
  isOpen: boolean;
  onClose: () => void;
  submit: (reasonCode: string, reasonText: string | undefined, key: string) => Promise<ActionResult>;
}

export function ReasonConfirm({ title, confirmLabel, codedSet, reasons, body, doneTitle, tone = 'danger', isOpen, onClose, submit }: ReasonConfirmProps) {
  const router = useRouter();
  const toast = useToast();
  const keyFor = useSubmissionKey();
  const [error, setError] = useState('');
  const [needText, setNeedText] = useState(false);
  const saved = useRef(false); // done: the dialog is closing, a further click must not send a second request

  const confirm = async ({ reasonCode, reasonText }: { reasonCode?: string; reasonText?: string }) => {
    if (saved.current) return;
    setError('');
    const picked = reasons.find((r) => r.code === reasonCode);
    if (!reasonCode || (picked?.requires_text && !reasonText?.trim())) { setNeedText(true); return; }
    setNeedText(false);
    const res = await submit(reasonCode, reasonText, keyFor(`${reasonCode}|${reasonText ?? ''}`));
    if (!res.ok) { setError(failText(res)); return; }
    saved.current = true;
    toast.show({ tone: 'success', title: doneTitle });
    router.refresh();
    onClose();
  };

  return (
    <ConfirmDialog
      isOpen={isOpen} tone={tone} title={title} confirmLabel={confirmLabel} onCancel={onClose} onConfirm={confirm}
      requireReason={{ codedSet, options: reasons, freeText: { maxLength: 500, isRequired: false } }}
      body={
        <>
          {body}
          {needText ? <p role="alert" className="lims-error">Enter details for this reason.</p> : null}
          {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
        </>
      }
    />
  );
}

'use client';
// Shared shell of the T-20 dialogs and drawers: kit Dialog or Drawer + page-level failure notice (04-UI-UX §8 copy) + kit Form + Cancel / submit footer.
// Mounted by its parent only while open, so every opening starts with empty state. Submit returns nothing on success, or the failure to show; auth.mfa_required goes to onMfa.
// LD-140 (2026-11-13, binding): kit components only; the submit button is the dialog's primary button.
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import type { CaseStatus } from '../../server/types';
import { FailNotice, type Fail } from '../common';

export interface FormDialogProps {
  title: string;
  submitLabel: string;
  /** Case status for the "That step isn't possible" copy; omitted by dialogs that are not about a case (T-22 New batch). */
  status?: CaseStatus;
  /** Destructive submit (cancel): danger-styled button instead of the primary one. */
  danger?: boolean;
  /** 'drawer' renders the kit Drawer (assessment); default is the Dialog. */
  as?: 'dialog' | 'drawer';
  /** T-23: Drawer width (assay editor is large). */
  width?: 'md' | 'lg';
  /** T-23: own failure copy (configuration screens show the server's validation message). */
  describe?: (f: Fail) => string | undefined;
  onClose: () => void;
  onMfa: () => void;
  onSubmit: () => Promise<Fail | undefined>;
  children: ReactNode;
}

export function FormDialog({ title, submitLabel, status, danger, as = 'dialog', width = 'md', describe, onClose, onMfa, onSubmit, children }: FormDialogProps) {
  const body = useRef<HTMLDivElement>(null);
  const [fail, setFail] = useState<Fail>();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const submit = async () => {
    if (busy.current) return; // one request per press
    busy.current = true;
    setFail(undefined);
    setPending(true);
    try {
      const f = await onSubmit();
      if (f) {
        if (f.code === 'auth.mfa_required') onMfa();
        else setFail(f);
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const footer = (
    <>
      <Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} isLoading={pending} onPress={() => body.current?.querySelector('form')?.requestSubmit()}>{submitLabel}</Button>
    </>
  );
  const content = (
    <div ref={body}>
      <FailNotice fail={fail} {...(status ? { status } : {})} {...(describe ? { describe } : {})} />
      <Form onSubmit={submit}>{children}</Form>
      {as === 'drawer' ? <div className="lims-dialog-footer">{footer}</div> : null}
    </div>
  );
  return as === 'drawer' ? (
    <Drawer title={title} isOpen onClose={onClose} width={width}>{content}</Drawer>
  ) : (
    <Dialog title={title} isOpen onClose={onClose} footer={footer}>{content}</Dialog>
  );
}

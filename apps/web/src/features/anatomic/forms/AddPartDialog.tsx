'use client';
// 04-UI-UX §4.2.2 [Add part] dialog: Site required (≤ 200), Description (≤ 1000). POST /parts (x-idempotency: required).
// LD-140 (2026-11-13): kit components only.
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { addPartAction } from '../server/actions';
import { FailNotice, newKey, type Fail } from '../components/common';
import type { CaseStatus } from '../server/types';

export function AddPartDialog({ caseId, status, isOpen, onClose, onMfa, onDone }: { caseId: string; status: CaseStatus; isOpen: boolean; onClose: () => void; onMfa: () => void; onDone: () => void }) {
  const toast = useToast();
  const body = useRef<HTMLDivElement>(null);
  const [site, setSite] = useState('');
  const [description, setDescription] = useState('');
  const [fail, setFail] = useState<Fail>();
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setFail(undefined);
    setPending(true);
    try {
      const r = await addPartAction(caseId, { site_text: site, ...(description ? { description_text: description } : {}) }, newKey());
      if (r.ok) {
        toast.show({ tone: 'success', title: `Part ${r.data.letter} added` });
        onDone();
      } else if (r.code === 'auth.mfa_required') onMfa();
      else setFail(r);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      title="Add part"
      isOpen={isOpen}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button>
          <Button variant="primary" isLoading={pending} onPress={() => body.current?.querySelector('form')?.requestSubmit()}>Add part</Button>
        </>
      }
    >
      <div ref={body}>
        <FailNotice fail={fail} status={status} />
        <Form onSubmit={submit}>
          <TextField label="Site (required)" name="site_text" maxLength={200} isRequired value={site} onChange={setSite} />
          <TextField label="Description" name="description_text" maxLength={1000} value={description} onChange={setDescription} />
        </Form>
      </div>
    </Dialog>
  );
}

'use client';
// 04-UI-UX §4.2.1 Accession dialog (Dialog size lg, title "Accession case"). Every existing part is listed (API rule); Site is required.
// LD-140 (2026-11-13): kit components only. Required fields are marked with text "(required)", not colour (§6).
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { Dialog } from '@lims/ui/components/Dialog';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { Form } from '@lims/ui/components/Form';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { accessionCaseAction, listAssigneesAction } from '../server/actions';
import type { Assignee, CaseDetail } from '../server/types';
import { FailNotice, newKey, type Fail } from '../components/common';

export function AccessionDialog({ detail, isOpen, onClose, onMfa, onDone }: { detail: CaseDetail; isOpen: boolean; onClose: () => void; onMfa: () => void; onDone: () => void }) {
  const toast = useToast();
  const body = useRef<HTMLDivElement>(null);
  const key = useRef<string | undefined>(undefined);
  const [sites, setSites] = useState<Record<string, string>>(() => Object.fromEntries(detail.parts.map((p) => [p.id, p.site_text ?? ''])));
  const [descriptions, setDescriptions] = useState<Record<string, string>>(() => Object.fromEntries(detail.parts.map((p) => [p.id, p.description_text ?? ''])));
  const [history, setHistory] = useState(''); // 04-UI-UX §4.2.1: Clinical history default "—" (empty), not prefilled from the case
  const [assignee, setAssignee] = useState<Assignee | undefined>(detail.assigned_pathologist ? { membership_id: detail.assigned_pathologist.membership_id, display_name: detail.assigned_pathologist.display_name } : undefined);
  const [fail, setFail] = useState<Fail>();
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setFail(undefined);
    setPending(true);
    key.current ??= newKey(); // one Idempotency-Key per intent; a failed attempt is retried with the same key only for step-up (02-CV §4.5)
    try {
      const r = await accessionCaseAction(detail.id, detail.version, {
        ...(history.trim() ? { clinical_history_text: history } : {}),
        ...(assignee ? { assigned_pathologist_membership_id: assignee.membership_id } : {}),
        parts: detail.parts.map((p) => ({
          part_id: p.id,
          site_text: sites[p.id] ?? '',
          ...(descriptions[p.id] ? { description_text: descriptions[p.id]! } : {}),
        })),
      }, key.current);
      if (r.ok) {
        key.current = undefined;
        toast.show({ tone: 'success', title: `Accessioned as ${r.data.accession_no ?? ''}`.trim() });
        onDone();
        return;
      }
      if (r.code === 'auth.mfa_required') return onMfa();
      key.current = undefined;
      setFail(r);
    } finally {
      setPending(false);
    }
  };

  const pattern = fail?.code === 'anatomic.accession_pattern_invalid' || fail?.code === 'anatomic.accession_duplicate';
  return (
    <Dialog
      title="Accession case"
      size="lg"
      isOpen={isOpen}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button>
          <Button variant="primary" isLoading={pending} onPress={() => body.current?.querySelector('form')?.requestSubmit()}>Accession</Button>
        </>
      }
    >
      <div ref={body}>
        {fail && pattern ? (
          <ErrorState title={fail.code === 'anatomic.accession_duplicate' ? 'This accession number already exists. Ask an administrator to check the accession pattern.' : 'Accession numbering is misconfigured. Ask an administrator to check the accession pattern.'} {...(fail.requestId ? { requestId: fail.requestId } : {})} />
        ) : (
          <FailNotice fail={fail} status={detail.status} />
        )}
        <Form onSubmit={submit}>
          {detail.parts.map((p) => (
            <div key={p.id}>
              <p><span className="lims-mono">{p.letter}</span></p>
              <TextField label={`Site, part ${p.letter} (required)`} name={`site_${p.id}`} maxLength={200} isRequired value={sites[p.id] ?? ''} onChange={(v) => setSites((s) => ({ ...s, [p.id]: v }))} />
              <TextField label={`Description, part ${p.letter}`} name={`description_${p.id}`} maxLength={1000} value={descriptions[p.id] ?? ''} onChange={(v) => setDescriptions((s) => ({ ...s, [p.id]: v }))} />
            </div>
          ))}
          <TextArea label="Clinical history" name="clinical_history_text" rows={4} maxLength={4000} showCount value={history} onChange={setHistory} />
          <Combobox<Assignee>
            label="Assigned pathologist"
            name="assigned_pathologist"
            {...(assignee ? { value: assignee } : {})}
            onChange={setAssignee}
            loadOptions={async (q) => {
              const r = await listAssigneesAction(detail.id, q);
              return r.ok ? r.data : [];
            }}
            getKey={(a) => a.membership_id}
            renderOption={(a) => a.display_name}
            renderValue={(a) => a.display_name}
          />
        </Form>
      </div>
    </Dialog>
  );
}

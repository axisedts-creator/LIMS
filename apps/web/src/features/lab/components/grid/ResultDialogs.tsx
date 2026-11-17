// C5.T-20 — verify prompt, return dialog, amend dialog (04-UI-UX §3.6). Reason lists come from the coded sets; the amend dialog drops the three module-only codes itself (D-61, 08 R1).
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { TextField } from '@lims/ui/components/TextField';
import type { AckFlag, AmendBody, CodedOption, GridResult } from '../../server/types';
import { ACK_LABEL, nameOf, valueOf, validateValue, valueField, type AnalyteMap } from './resultModel';

const MODULE_ONLY = ['module_phase_progression', 'module_preliminary_update', 'supplementary_report'];

/** Rows with delta / critical / unit / instrument flags: one tick per flag; Verify stays disabled until every box is ticked. */
export function VerifyPrompt({ rows, analytes, onCancel, onVerify }: {
  rows: readonly { result: GridResult; flags: AckFlag[] }[]; analytes: AnalyteMap; onCancel: () => void; onVerify: (acks: Record<string, AckFlag[]>) => void;
}) {
  const [ticked, setTicked] = useState<Record<string, AckFlag[]>>({});
  const done = rows.every(({ result, flags }) => flags.every((f) => ticked[result.id]?.includes(f)));
  const flip = (id: string, f: AckFlag, on: boolean) => setTicked((p) => ({ ...p, [id]: on ? [...(p[id] ?? []), f] : (p[id] ?? []).filter((x) => x !== f) }));
  return (
    <Dialog title="Review flagged results" isOpen onClose={onCancel}
      footer={<><Button variant="ghost" onPress={onCancel}>Cancel</Button><Button variant="primary" isDisabled={!done} onPress={() => onVerify(ticked)}>Verify</Button></>}>
      <ul>
        {rows.map(({ result, flags }) => (
          <li key={result.id}>
            <strong>{`${nameOf(result, analytes)} ${result.analyte_code}: ${valueOf(result)}`}</strong>
            {flags.map((f) => <Checkbox key={f} label={ACK_LABEL[f]} isSelected={ticked[result.id]?.includes(f) ?? false} onChange={(on) => flip(result.id, f, on)} />)}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Reason (required, return_reasons) + comment ≤ 500. Success text is shown by the grid. */
export function ReturnDialog({ reasons, onCancel, onReturn }: {
  reasons: readonly CodedOption[]; onCancel: () => void; onReturn: (reasonCode: string, comment: string) => Promise<string | null>;
}) {
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <ConfirmDialog title="Return result for correction" confirmLabel="Return" isOpen onCancel={onCancel}
      requireReason={{ codedSet: 'return_reasons', options: reasons }}
      body={<><TextField label="Comment" name="comment" maxLength={500} value={comment} onChange={setComment} />{err ? <div role="alert">{err}</div> : null}</>}
      onConfirm={async ({ reasonCode }) => { setErr(await onReturn(reasonCode ?? '', comment)); }} />
  );
}

/** New value (same editor rules as the grid, must differ) + reason (amendment_reasons) + detail ≤ 500. Stays open on an error. */
export function AmendDialog({ result, analytes, reasons, onCancel, onAmend }: {
  result: GridResult; analytes: AnalyteMap; reasons: readonly CodedOption[]; onCancel: () => void; onAmend: (body: AmendBody) => Promise<string | null>;
}) {
  const info = analytes[result.analyte_id];
  const [val, setVal] = useState('');
  const [verr, setVerr] = useState<string | undefined>();
  const [err, setErr] = useState<string | null>(null);
  const current = valueOf(result);
  return (
    <ConfirmDialog title="Amend result" confirmLabel="Amend" tone="danger" isOpen onCancel={onCancel}
      requireReason={{ codedSet: 'amendment_reasons', options: reasons.filter((r) => !MODULE_ONLY.includes(r.code)), freeText: { maxLength: 500, isRequired: false } }}
      body={(
        <>
          <p>{`Amend ${nameOf(result, analytes)} (current v${result.current_version_no}: ${current})`}</p>
          <p>{`This creates version ${result.current_version_no + 1}. The released report will be superseded.`}</p>
          <TextField label="New value" name="new_value" maxLength={2000} value={val} onChange={setVal} {...(verr ? { error: verr } : {})} />
          {err ? <div role="alert">{err}</div> : null}
        </>
      )}
      onConfirm={async ({ reasonCode, reasonText }) => {
        const v = val.trim();
        const bad = v === '' ? 'Enter the new value.' : validateValue(v, info) ?? (v === current || (Number.isFinite(Number(v)) && Number(v) === Number(current) && info?.value_type !== 'text') ? 'The new value must differ from the current value.' : null);
        setVerr(bad ?? undefined);
        if (bad) return;
        setErr(await onAmend({ ...valueField(v, info), amendment_reason_code: reasonCode ?? '', ...(reasonText ? { amendment_reason_text: reasonText } : {}) }));
      }} />
  );
}

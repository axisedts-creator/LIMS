'use client';
// Reason-coded confirmation (04-UI-UX §1: ConfirmDialog with requireReason). [CONV] The kit ConfirmDialog renders the reason as a react-aria Select
// (popover listbox, no native <option>s in the dialog); the reporting dialogs need a native <select> so the reason list is inside the dialog and
// keyboard/AT users get the platform control, and "details required for <code>" (regenerate: `other`). Same frame as the kit: Dialog + Cancel/Confirm.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { TextField } from '@lims/ui/components/TextField';
import type { ActionResult, CodedOption } from '../server/types';
import { errorText } from './format';

export function NativeSelect({ label, value, onChange, options, error, placeholder = 'Select…', name }: {
  label: string; value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; error?: string | undefined; placeholder?: string; name?: string;
}) {
  const id = useId();
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}</label>
      <select id={id} name={name} className="lims-input" value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error ? <p id={`${id}-e`} className="lims-error">{error}</p> : null}
    </div>
  );
}

export interface ReasonResult { reasonCode: string; reasonText: string }
export interface ReasonDialogProps {
  title: string; body?: ReactNode; confirmLabel: string; tone?: 'default' | 'danger'; isOpen: boolean; onCancel: () => void;
  /** Loads the coded set when the dialog opens. */
  load: () => Promise<ActionResult<CodedOption[]>>;
  /** Free-text label (default "Details"). */
  textLabel?: string;
  /** true = always required; a code = required only for that reason code (e.g. 'other'). Default: optional. */
  textRequired?: boolean | string;
  maxText?: number;
  /** Extra fields shown after the text field. */
  children?: ReactNode;
  /** Returns an error text to keep the dialog open, or nothing to close it. */
  onConfirm: (r: ReasonResult) => Promise<string | void> | string | void;
}

export function ReasonDialog({ title, body, confirmLabel, tone = 'default', isOpen, onCancel, load, textLabel = 'Details', textRequired = false, maxText = 500, children, onConfirm }: ReasonDialogProps) {
  const [options, setOptions] = useState<CodedOption[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<{ code?: string; text?: string }>({});
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    setCode(''); setText(''); setErrors({}); setFailure(undefined); setLoadError(undefined);
    let live = true;
    void load().then((r) => {
      if (!live) return;
      if (r.ok) setOptions([...r.data].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
      else setLoadError(errorText(r.code));
    }).catch(() => live && setLoadError('The reasons could not be loaded'));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const needText = textRequired === true || (typeof textRequired === 'string' && textRequired === code);
  const confirm = async () => {
    if (inFlight.current) return;
    const e: { code?: string; text?: string } = {};
    if (!code) e.code = 'Reason is required';
    if (needText && text.trim() === '') e.text = `${textLabel} is required`;
    setErrors(e);
    if (e.code || e.text) return;
    inFlight.current = true;
    setPending(true);
    try {
      const msg = await onConfirm({ reasonCode: code, reasonText: text.trim() });
      if (msg) setFailure(msg);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title={title} isOpen={isOpen} onClose={onCancel} size="sm" isDismissable={false}
      footer={<><Button variant="ghost" onPress={onCancel} isDisabled={pending}>Cancel</Button><Button variant={tone === 'danger' ? 'danger' : 'primary'} onPress={() => void confirm()} isLoading={pending}>{confirmLabel}</Button></>}
    >
      {body ? <div className="lims-confirm-body">{body}</div> : null}
      {loadError ? <p role="alert" className="lims-error">{loadError}</p> : null}
      <NativeSelect label="Reason" value={code} onChange={(v) => { setCode(v); setErrors(({ text: t }) => (t ? { text: t } : {})); }} options={(options ?? []).map((o) => ({ value: o.code, label: o.display }))} error={errors.code} />
      <TextField label={textLabel} name="reason_text" maxLength={maxText} value={text} onChange={setText} isRequired={needText} {...(errors.text ? { error: errors.text } : {})} />
      {children}
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
    </Dialog>
  );
}

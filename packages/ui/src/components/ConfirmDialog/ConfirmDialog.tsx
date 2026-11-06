import { useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../Dialog/Dialog';
import { Button } from '../Button/Button';
import { Select } from '../Select/Select';
import { TextField } from '../TextField/TextField';
import { msg } from '../_shared/messages';

export interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  isOpen: boolean;
  onCancel: () => void;
  requireReason?: {
    codedSet: string;
    options: readonly { code: string; display: string }[];
    freeText?: { maxLength: number; isRequired: boolean };
  };
  /** Reason-coded actions: reject, cancel, amend (IC §10). */
  onConfirm: (r: { reasonCode?: string; reasonText?: string }) => Promise<void> | void;
  'data-testid'?: string;
}

export function ConfirmDialog({ title, body, confirmLabel, tone = 'default', isOpen, onCancel, requireReason, onConfirm, ...rest }: ConfirmDialogProps) {
  const [reasonCode, setReasonCode] = useState<string>();
  const [reasonText, setReasonText] = useState('');
  const [errors, setErrors] = useState<{ code?: string; text?: string }>({});
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false); // synchronous guard: a second click before re-render must not fire twice

  const confirm = async () => {
    if (inFlight.current) return;
    if (requireReason) {
      const e: { code?: string; text?: string } = {};
      if (!reasonCode) e.code = msg.required(msg.reason);
      if (requireReason.freeText?.isRequired && reasonText.trim() === '') e.text = msg.required(msg.details);
      setErrors(e);
      if (e.code || e.text) return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      await onConfirm({
        ...(reasonCode ? { reasonCode } : {}),
        ...(requireReason?.freeText && reasonText ? { reasonText } : {}),
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title={title}
      isOpen={isOpen}
      onClose={onCancel}
      size="sm"
      isDismissable={false}
      {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
      footer={
        <>
          <Button variant="ghost" onPress={onCancel} isDisabled={pending}>
            {msg.cancel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onPress={() => void confirm()} isLoading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="lims-confirm-body">{body}</div>
      {requireReason ? (
        <>
          <Select
            label={msg.reason}
            name="reason_code"
            isRequired
            options={requireReason.options.map((o) => ({ value: o.code, label: o.display }))}
            {...(reasonCode ? { value: reasonCode } : {})}
            {...(errors.code ? { error: errors.code } : {})}
            onChange={(v) => {
              setReasonCode(v);
              setErrors(({ text }) => (text ? { text } : {}));
            }}
          />
          {requireReason.freeText ? (
            <TextField
              label={msg.details}
              name="reason_text"
              maxLength={requireReason.freeText.maxLength}
              isRequired={requireReason.freeText.isRequired}
              value={reasonText}
              {...(errors.text ? { error: errors.text } : {})}
              onChange={setReasonText}
            />
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}

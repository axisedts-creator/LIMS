import { useId, useState } from 'react';
import { Button } from '../Button/Button';
import { msg } from '../_shared/messages';
import { formatDateTime } from '../_shared/time';

/** C7 02-TRD:1094; requireAcknowledgement per C0 04-UI-UX §2.8. */
export interface SecretRevealOnceProps {
  label: string;
  /** The secret. Rendered once as a text node only (never in title, data or aria attributes). */
  secret: string;
  /** IsoUtc; shown as text when given. */
  expiresAt?: string;
  /** Default true: Done stays disabled until the user ticks the acknowledgement. */
  requireAcknowledgement?: boolean;
  onAcknowledged: () => void;
  'data-testid'?: string;
}

/** C2 TOTP setup key / C7 enrolment code (C2 04-UI-UX:59, C7 04-UI-UX:201). After Done the secret leaves the DOM for good. */
export function SecretRevealOnce({ label, secret, expiresAt, requireAcknowledgement = true, onAcknowledged, ...rest }: SecretRevealOnceProps) {
  const id = useId();
  const [done, setDone] = useState(false);
  const [ack, setAck] = useState(false);
  const [copied, setCopied] = useState(false);
  if (done) return null;
  return (
    <div className="lims-secret" {...rest}>
      <p role="status" className="lims-description">
        Code shown. Copy it now.
      </p>
      <span className="lims-label">{label}</span>
      <code className="lims-mono lims-secret-value">{secret}</code>
      <p className="lims-description">This is shown only once. It cannot be shown again after you close this.</p>
      {expiresAt ? <p className="lims-description">Expires {formatDateTime(expiresAt)}</p> : null}
      <Button
        size="sm"
        onPress={() => {
          void navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {copied ? msg.copied : msg.copy}
      </Button>
      {requireAcknowledgement ? (
        <label className="lims-check" htmlFor={`${id}-ack`}>
          <input id={`${id}-ack`} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I have copied this code</span>
        </label>
      ) : null}
      <Button
        variant="primary"
        isDisabled={requireAcknowledgement && !ack}
        onPress={() => {
          setDone(true);
          onAcknowledged();
        }}
      >
        Done
      </Button>
    </div>
  );
}

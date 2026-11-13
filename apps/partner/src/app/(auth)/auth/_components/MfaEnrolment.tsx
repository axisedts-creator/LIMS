'use client';
// PA-3 MFA enrolment (04-UI-UX §2, US-02.7): QR arrives from the API as base64 SVG and is shown only via the kit DataUriImage
// (<img>, never inline SVG — REQ-SEC-088); the key via SecretRevealOnce. Reached when the session is mfa_enrolment_required.
import { useId, useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataUriImage } from '@lims/ui/components/DataUriImage';
import { SecretRevealOnce } from '@lims/ui/components/SecretRevealOnce';
import { errorCopy, type ActionResult } from '../messages';

type Failure = Extract<ActionResult, { ok: false }>;
type Started = { ok: true; factor_id: string; otpauth_uri: string; qr_svg_base64?: string; secret_base32: string };

export interface MfaEnrolmentProps {
  startAction: (fd: FormData) => Promise<Started | Failure>;
  /** Success redirects (server side); a returned value is always a failure. */
  completeAction: (fd: FormData) => Promise<ActionResult>;
}

const DEFAULT_DEVICE = 'Authenticator';

export function MfaEnrolment({ startAction, completeAction }: MfaEnrolmentProps) {
  const id = useId();
  const [enrol, setEnrol] = useState<Started>();
  const [failure, setFailure] = useState<Failure>();
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    setFailure(undefined);
    try {
      const fd = new FormData();
      fd.set('friendly_name', DEFAULT_DEVICE);
      const r = await startAction(fd);
      if (r.ok) setEnrol(r);
      else setFailure(r);
    } catch {
      setFailure({ ok: false, code: 'common.dependency_unavailable' });
    } finally {
      setPending(false);
    }
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || !enrol) return;
    const fd = new FormData(e.currentTarget);
    if (!/^[0-9]{6}$/.test(String(fd.get('code') ?? ''))) return setFailure({ ok: false, code: 'auth.mfa_invalid' });
    fd.set('factor_id', enrol.factor_id);
    setPending(true);
    setFailure(undefined);
    try {
      const r = await completeAction(fd);
      if (r && !r.ok) setFailure(r);
    } catch {
      setFailure({ ok: false, code: 'common.dependency_unavailable' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="lims-auth-card">
      <h1>Set up two-step verification</h1>
      <Banner tone="info" title="Your organisation requires a second sign-in step." />
      {failure ? (
        <div role="alert">
          <Banner tone="danger" title={errorCopy(failure)} />
        </div>
      ) : null}
      {enrol ? (
        <>
          <p>Scan this code with an authenticator app, then enter the 6-digit code.</p>
          {enrol.qr_svg_base64 ? <DataUriImage src={`data:image/svg+xml;base64,${enrol.qr_svg_base64}`} alt="QR code for your authenticator app" /> : null}
          <SecretRevealOnce label="Can't scan? Enter this key" secret={enrol.secret_base32} onAcknowledged={() => {}} />
          <form noValidate onSubmit={confirm}>
            <div className="lims-field">
              <label className="lims-label" htmlFor={`${id}-code`}>
                Authentication code
              </label>
              <input
                id={`${id}-code`}
                className="lims-input lims-mono"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="^[0-9]{6}$"
                maxLength={6}
                required
                disabled={pending}
              />
            </div>
            <Button type="submit" variant="primary" isLoading={pending}>
              Confirm
            </Button>
          </form>
        </>
      ) : (
        <>
          <p>Install an authenticator app on your phone (any TOTP app).</p>
          <Button variant="primary" isLoading={pending} onPress={() => void start()}>
            Continue
          </Button>
        </>
      )}
    </div>
  );
}

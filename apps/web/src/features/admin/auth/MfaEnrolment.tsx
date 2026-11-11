'use client';
// AU-3 MFA enrolment (04-UI-UX §4): 3 steps; the QR comes from the API as base64 SVG and is shown only via the kit
// DataUriImage (<img>, never inline SVG — REQ-SEC-088); the key via SecretRevealOnce.
import { useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataUriImage } from '@lims/ui/components/DataUriImage';
import { OtpInput } from '@lims/ui/components/OtpInput';
import { SecretRevealOnce } from '@lims/ui/components/SecretRevealOnce';
import { errorCopy, type ActionResult } from './messages';

type Failure = Extract<ActionResult, { ok: false }>;
type Started = { ok: true; factor_id: string; otpauth_uri: string; qr_svg_base64?: string; secret_base32: string };

export interface MfaEnrolmentProps {
  startAction: (fd: FormData) => Promise<Started | Failure>;
  completeAction: (fd: FormData) => Promise<ActionResult>;
  /** AU-3 reached because the role requires MFA (mfa_enrolment_required). */
  forced?: boolean;
}

const DEFAULT_DEVICE = 'Authenticator';

export function MfaEnrolment({ startAction, completeAction, forced }: MfaEnrolmentProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 'done'>(1);
  const [enrol, setEnrol] = useState<Started>();
  const [device, setDevice] = useState(DEFAULT_DEVICE);
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure>();
  const [pending, setPending] = useState(false);

  async function run<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setFailure(undefined);
    try {
      const r = await fn();
      if (!r.ok) setFailure(r as unknown as Failure);
      return r;
    } catch {
      setFailure({ ok: false, code: 'common.dependency_unavailable' });
      return undefined;
    } finally {
      setPending(false);
    }
  }

  async function openStep2() {
    setStep(2);
    // ponytail: friendly_name is fixed when the factor is created, so the default name is sent here; a rename
    // after the QR is shown needs an API operation the catalogue does not have.
    const fd = new FormData();
    fd.set('friendly_name', device.trim() || DEFAULT_DEVICE);
    const r = await run(() => startAction(fd));
    if (r?.ok) setEnrol(r as Started);
  }

  async function confirm(v: string) {
    if (pending || !enrol || !/^[0-9]{6}$/.test(v)) return;
    const fd = new FormData();
    fd.set('factor_id', enrol.factor_id);
    fd.set('code', v);
    const r = await run(() => completeAction(fd));
    if (r?.ok) setStep('done');
  }

  return (
    <div className="lims-auth-card">
      <h1>Set up two-step verification</h1>
      {forced ? <Banner tone="info" title="Your role requires two-step verification before you can continue." /> : null}
      {step !== 'done' ? <p className="lims-description">Step {step} of 3</p> : null}
      {failure ? (
        <div role="alert">
          <Banner tone="danger" title={errorCopy(failure)} />
        </div>
      ) : null}

      {step === 1 ? (
        <>
          <p>Install an authenticator app on your phone (any TOTP app).</p>
          <Button variant="primary" onPress={() => void openStep2()}>
            Continue
          </Button>
        </>
      ) : null}

      {step === 2 ? (
        <>
          {enrol ? (
            <>
              {enrol.qr_svg_base64 ? (
                <DataUriImage src={`data:image/svg+xml;base64,${enrol.qr_svg_base64}`} alt="QR code for your authenticator app" />
              ) : null}
              <SecretRevealOnce label="Can't scan? Enter this key" secret={enrol.secret_base32} onAcknowledged={() => {}} />
            </>
          ) : pending ? (
            <p role="status">Loading…</p>
          ) : null}
          <div className="lims-field">
            <label className="lims-label" htmlFor="mfa-device-name">
              Device name
            </label>
            <input
              id="mfa-device-name"
              className="lims-input"
              name="friendly_name"
              maxLength={40}
              value={device}
              disabled={!!enrol}
              onChange={(e) => setDevice(e.target.value)}
            />
          </div>
          <Button variant="primary" isDisabled={!enrol} onPress={() => setStep(3)}>
            Continue
          </Button>
        </>
      ) : null}

      {step === 3 ? (
        <form
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void confirm(code);
          }}
        >
          {/* onComplete fires on fill AND on Enter; only Enter (value already committed) submits */}
          <OtpInput label="Authentication code" length={6} value={code} onChange={setCode} onComplete={(v) => v === code && void confirm(v)} isDisabled={pending} />
          <Button type="submit" variant="primary" isLoading={pending}>
            Confirm
          </Button>
        </form>
      ) : null}

      {step === 'done' ? (
        <>
          <p role="status">Two-step verification is on.</p>
          <a href="/">Continue to LIMS</a>
        </>
      ) : null}
    </div>
  );
}

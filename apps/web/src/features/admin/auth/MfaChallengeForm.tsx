'use client';
// AU-2 MFA challenge (04-UI-UX §4).
import { useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { OtpInput } from '@lims/ui/components/OtpInput';
import { errorCopy, type ActionResult } from './messages';

export interface MfaChallengeFormProps {
  action: (fd: FormData) => Promise<ActionResult>;
  logoutAction: () => Promise<unknown>;
}

export function MfaChallengeForm({ action, logoutAction }: MfaChallengeFormProps) {
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Extract<ActionResult, { ok: false }>>();
  const [pending, setPending] = useState(false);

  async function submit(v: string) {
    if (pending || !/^[0-9]{6}$/.test(v)) return;
    const fd = new FormData();
    fd.set('code', v);
    setPending(true);
    setFailure(undefined);
    try {
      const r = await action(fd);
      if (r && !r.ok) setFailure(r);
    } catch {
      setFailure({ ok: false, code: 'common.dependency_unavailable' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="lims-auth-card">
      <h1>Two-step verification</h1>
      <p>Enter the 6-digit code from your authenticator app.</p>
      {failure ? (
        <div role="alert">
          <Banner tone="danger" title={errorCopy(failure)} />
        </div>
      ) : null}
      <form
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        {/* OtpInput fires onComplete on fill AND on Enter; only Enter (value already committed) submits */}
        <OtpInput label="Authentication code" length={6} value={code} onChange={setCode} onComplete={(v) => v === code && void submit(v)} isDisabled={pending} />
        <Button type="submit" variant="primary" isLoading={pending}>
          Verify
        </Button>
      </form>
      <Button variant="ghost" onPress={() => void logoutAction()}>
        Use a different account
      </Button>
    </div>
  );
}

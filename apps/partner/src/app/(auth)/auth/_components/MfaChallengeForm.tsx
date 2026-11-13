'use client';
// PA-2 MFA challenge (04-UI-UX §2): one 6-digit one-time-code field.
import { useId, useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { errorCopy, type ActionResult } from '../messages';

export interface MfaChallengeFormProps {
  action: (fd: FormData) => Promise<ActionResult>;
  logoutAction: () => Promise<unknown>;
}

export function MfaChallengeForm({ action, logoutAction }: MfaChallengeFormProps) {
  const id = useId();
  const [failure, setFailure] = useState<Extract<ActionResult, { ok: false }>>();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    if (!/^[0-9]{6}$/.test(String(fd.get('code') ?? ''))) return setFailure({ ok: false, code: 'auth.mfa_invalid' });
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
      <form noValidate onSubmit={onSubmit}>
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
          Verify
        </Button>
      </form>
      <Button variant="ghost" onPress={() => void logoutAction()}>
        Use a different account
      </Button>
    </div>
  );
}

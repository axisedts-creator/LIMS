'use client';
// PA-6 Set password (04-UI-UX §2): >= 12 chars shown as a hint + confirmation; breach check happens server-side on save.
import { useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { errorCopy, type ActionResult } from '../messages';
import { PasswordField } from './PasswordField';

export interface SetPasswordFormProps {
  action: (fd: FormData) => Promise<ActionResult>;
}

export function SetPasswordForm({ action }: SetPasswordFormProps) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErr, setFieldErr] = useState<{ pw?: string; confirm?: string }>({});
  const [failure, setFailure] = useState<Extract<ActionResult, { ok: false }>>();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const errs = {
      ...(pw.length >= 12 ? {} : { pw: 'Use at least 12 characters.' }),
      ...(confirm === pw ? {} : { confirm: 'Passwords do not match.' }),
    };
    setFieldErr(errs);
    if (errs.pw || errs.confirm) return;
    const fd = new FormData(e.currentTarget);
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
      <h1>Choose a password</h1>
      {failure ? (
        <div role="alert">
          <Banner tone="danger" title={errorCopy(failure)} />
        </div>
      ) : null}
      <form noValidate onSubmit={onSubmit}>
        <PasswordField label="New password" name="new_password" autoComplete="new-password" maxLength={128} value={pw} onChange={setPw} error={fieldErr.pw} isDisabled={pending} />
        <p className="lims-description">Use at least 12 characters.</p>
        <PasswordField
          label="Confirm password"
          name="confirm_password"
          autoComplete="new-password"
          maxLength={128}
          value={confirm}
          onChange={setConfirm}
          error={fieldErr.confirm}
          isDisabled={pending}
        />
        <Button type="submit" variant="primary" isLoading={pending}>
          Set password
        </Button>
      </form>
    </div>
  );
}

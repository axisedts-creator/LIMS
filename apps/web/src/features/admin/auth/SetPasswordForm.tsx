'use client';
// AU-5 Set password (AC-A7.3, AC-A8.1): 12–128 chars + confirmation; breach check happens server-side on save.
import { useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { PasswordField } from './PasswordField';
import { errorCopy, type ActionResult } from './messages';

export interface SetPasswordFormProps {
  action: (fd: FormData) => Promise<ActionResult>;
  variant: 'invite' | 'recovery';
  tenantName?: string;
}

export function SetPasswordForm({ action, variant, tenantName }: SetPasswordFormProps) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErr, setFieldErr] = useState<{ pw?: string; confirm?: string }>({});
  const [failure, setFailure] = useState<Extract<ActionResult, { ok: false }>>();
  const [pending, setPending] = useState(false);
  const longEnough = pw.length >= 12;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const errs = {
      ...(longEnough ? {} : { pw: 'Use at least 12 characters.' }),
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
      <h1>{variant === 'invite' ? `Welcome to ${tenantName ?? 'LIMS'}` : 'Choose a new password'}</h1>
      {failure ? (
        <div role="alert">
          <Banner tone="danger" title={errorCopy(failure)} />
        </div>
      ) : null}
      <form noValidate onSubmit={onSubmit}>
        <PasswordField label="New password" name="new_password" autoComplete="new-password" maxLength={128} value={pw} onChange={setPw} error={fieldErr.pw} isDisabled={pending} />
        <ul className="lims-checklist" aria-live="polite">
          <li data-met={longEnough}>
            {longEnough ? '✓ ' : ''}At least 12 characters
          </li>
          <li>Not a commonly leaked password (checked when you save)</li>
        </ul>
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

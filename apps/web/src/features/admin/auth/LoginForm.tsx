'use client';
// AU-1 Login (04-UI-UX §4). Lab-neutral: no tenant branding before login.
import { useId, useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { PasswordField } from './PasswordField';
import { EMAIL_RE, errorCopy, type ActionResult } from './messages';

export interface LoginFormProps {
  action: (fd: FormData) => Promise<ActionResult>;
  loggedOut?: boolean;
  /** AU-2: session revoked after 5 wrong codes. */
  mfaFailed?: boolean;
  next?: string;
}

export function LoginForm({ action, loggedOut, mfaFailed, next }: LoginFormProps) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string }>({});
  const [failure, setFailure] = useState<Extract<ActionResult, { ok: false }>>();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const errs = {
      ...(EMAIL_RE.test(email.trim()) ? {} : { email: 'Enter a valid email address.' }),
      ...(password ? {} : { password: 'Enter your password.' }),
    };
    setFieldErr(errs);
    if (errs.email || errs.password) return;
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
      <p className="lims-wordmark">LIMS</p>
      <h1>Log in</h1>
      {loggedOut ? <Banner tone="info" title="You have been logged out." /> : null}
      {mfaFailed ? <Banner tone="warning" title="Too many incorrect codes. Log in again." /> : null}
      {failure ? (
        <div role="alert">
          <Banner tone="danger" title={errorCopy(failure)} />
        </div>
      ) : null}
      <form noValidate onSubmit={onSubmit}>
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <div className="lims-field">
          <label className="lims-label" htmlFor={`${id}-email`}>
            Email
          </label>
          <input
            id={`${id}-email`}
            className="lims-input"
            name="email"
            type="email"
            autoComplete="username"
            maxLength={254}
            required
            value={email}
            disabled={pending}
            aria-invalid={fieldErr.email ? true : undefined}
            aria-describedby={fieldErr.email ? `${id}-email-e` : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />
          {fieldErr.email ? (
            <span id={`${id}-email-e`} className="lims-error">
              {fieldErr.email}
            </span>
          ) : null}
        </div>
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          maxLength={128}
          value={password}
          onChange={setPassword}
          error={fieldErr.password}
          isDisabled={pending}
        />
        <Button type="submit" variant="primary" isLoading={pending}>
          Log in
        </Button>
      </form>
      <a href="/auth/forgot">Forgot password?</a>
    </div>
  );
}

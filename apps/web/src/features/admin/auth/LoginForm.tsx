'use client';
// AU-1 Login (04-UI-UX §4). Lab-neutral: no tenant branding before login.
import { useId, useState, type FormEvent } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { RequiredNote } from '../ui';
import { AuthIcon } from './AuthArt';
import { PasswordField } from './PasswordField';
import { EMAIL_RE, errorCopy, type ActionResult } from './messages';
import { useAuthSubmit, WakingState } from './WakingState';

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
  const { failure, pending, send, retry } = useAuthSubmit(action);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const errs = {
      ...(EMAIL_RE.test(email.trim()) ? {} : { email: 'Enter a valid email address.' }),
      ...(password ? {} : { password: 'Enter your password.' }),
    };
    setFieldErr(errs);
    if (errs.email || errs.password) return;
    await send(new FormData(e.currentTarget));
  }

  if (failure?.waking) return <WakingState onRetry={retry} />; // T0D-WAKE-1 (LD-277)
  return (
    <div className="lims-auth-card">
      {/* T0D-MSERIES-2 (LD-251, 13-M-SERIES s5): the Metro Labs logo sits in the auth layout; no placeholder mark in the card */}
      {/* T0D-MSERIES-5 (LD-276, board M1-entry): pill, heading, text, Work email, Forgot password? on the password label row, Continue.
          The board's Patient or partner portal button has no route in contracts/routes.yaml, so it is left out (LD-250). */}
      <span className="lims-auth-pill">Staff sign-in</span>
      <h1>Welcome back</h1>
      <p>Sign in with your work email. A one-time code confirms it is you.</p>
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
          <div className="lims-label-row">
            <label className="lims-label" htmlFor={`${id}-email`}>
              Work email
            </label>
            <RequiredNote />
          </div>
          <div className="lims-input-wrap">
            <AuthIcon kind="mail" className="lims-input-icon" />
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
          </div>
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
          labelAction={<a href="/auth/forgot">Forgot password?</a>}
        />
        <Button type="submit" variant="primary" isLoading={pending}>
          Continue
          <AuthIcon kind="arrow" className="lims-btn-arrow" />
        </Button>
      </form>
    </div>
  );
}

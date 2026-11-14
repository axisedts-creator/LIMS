'use client';
// AU-4 Forgot password (AC-A7.1): after submit the same message is shown whatever the outcome (no existence oracle);
// the email is echoed from the form, not from the server.
import { useState, type FormEvent } from 'react';
import { Button } from '@lims/ui/components/Button';
import { EMAIL_RE, type ActionResult } from './messages';

export interface ForgotPasswordFormProps {
  action: (fd: FormData) => Promise<ActionResult>;
}

export function ForgotPasswordForm({ action }: ForgotPasswordFormProps) {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = email.trim();
    if (pending) return;
    if (!EMAIL_RE.test(v)) return setErr('Enter a valid email address.');
    setErr(undefined);
    const fd = new FormData(e.currentTarget);
    setPending(true);
    try {
      await action(fd);
    } catch {
      // ignored: the message below is constant by design
    } finally {
      setPending(false);
      setSentTo(v);
    }
  }

  return (
    <div className="lims-auth-card">
      <h1>Reset your password</h1>
      {sentTo !== undefined ? (
        <p role="status">
          If an account exists for {sentTo}, we have sent a reset link. The link works once and expires in 60 minutes.
        </p>
      ) : (
        <form noValidate onSubmit={onSubmit}>
          <div className="lims-field">
            <label className="lims-label" htmlFor="forgot-email">
              Email
            </label>
            <input
              id="forgot-email"
              className="lims-input"
              name="email"
              type="email"
              autoComplete="username"
              maxLength={254}
              required
              value={email}
              disabled={pending}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? 'forgot-email-e' : undefined}
              onChange={(e) => setEmail(e.target.value)}
            />
            {err ? (
              <span id="forgot-email-e" className="lims-error">
                {err}
              </span>
            ) : null}
          </div>
          <Button type="submit" variant="primary" isLoading={pending}>
            Send reset link
          </Button>
        </form>
      )}
      <a href="/auth/login">Back to log in</a>
    </div>
  );
}

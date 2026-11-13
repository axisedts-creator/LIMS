'use client';
// PA-4 Forgot password: after submit the same constant message is shown whatever the outcome (no existence oracle).
import { useState, type FormEvent } from 'react';
import { Button } from '@lims/ui/components/Button';
import { EMAIL_RE, type ActionResult } from '../messages';

export interface ForgotPasswordFormProps {
  action: (fd: FormData) => Promise<ActionResult>;
}

export function ForgotPasswordForm({ action }: ForgotPasswordFormProps) {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string>();
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    if (!EMAIL_RE.test(email.trim())) return setErr('Enter a valid email address.');
    setErr(undefined);
    const fd = new FormData(e.currentTarget);
    setPending(true);
    try {
      await action(fd);
    } catch {
      // ignored: the message below is constant by design
    } finally {
      setPending(false);
      setSent(true);
    }
  }

  return (
    <div className="lims-auth-card">
      <h1>Reset your password</h1>
      {sent ? (
        <p role="status">If an account exists for this email, we've sent a reset link.</p>
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
              inputMode="email"
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
      <a href="/auth/login">Back to sign in</a>
    </div>
  );
}

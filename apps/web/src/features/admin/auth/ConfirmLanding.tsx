'use client';
// /auth/confirm landing (AC-A7.2, AC-A8.2): exchanges the one-time link token via a server action on mount (link
// scanners that do not run JS cannot burn it). The token is never rendered; errors are identical per code (no oracle).
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@lims/ui/components/Spinner';
import { errorCopy, type ActionResult } from './messages';

export interface ConfirmLandingProps {
  action: (a: { token_hash: string; type: 'recovery' | 'invite' }) => Promise<ActionResult>;
  tokenHash: string;
  type: 'recovery' | 'invite';
}

export function ConfirmLanding({ action, tokenHash, type }: ConfirmLandingProps) {
  const started = useRef(false);
  const [code, setCode] = useState<string>();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    action({ token_hash: tokenHash, type }).then(
      (r) => {
        if (r && !r.ok) setCode(r.code);
      },
      () => setCode('common.dependency_unavailable'),
    );
  }, [action, tokenHash, type]);

  if (!code) return <Spinner label="Checking your link…" />;
  return (
    <div className="lims-auth-card" role="alert">
      <p>{errorCopy({ code })}</p>
      {code === 'auth.reset_token_invalid' ? <a href="/auth/forgot">Forgot password</a> : null}
    </div>
  );
}

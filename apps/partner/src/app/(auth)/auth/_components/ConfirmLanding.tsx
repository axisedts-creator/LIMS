'use client';
// PA-5 /auth/confirm landing: exchanges the one-time link token via a server action on mount (link scanners that do not run
// JS cannot burn it). Success redirects server-side to a clean URL; the token is never rendered; every failure shows the same copy.
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@lims/ui/components/Spinner';
import { errorCopy, type ActionResult } from '../messages';

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
      <p>{errorCopy({ code: code === 'common.dependency_unavailable' || code === 'common.rate_limited' ? code : 'auth.reset_token_invalid' })}</p>
      <a href="/auth/login">Back to sign in</a>
    </div>
  );
}

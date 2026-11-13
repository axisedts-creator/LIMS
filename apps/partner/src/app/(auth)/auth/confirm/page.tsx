// PA-5 /auth/confirm landing (invitation / recovery link). The one-time token must not leak via Referer.
import type { Metadata } from 'next';
import { ConfirmLanding } from '../_components/ConfirmLanding';
import { confirmTokenAction } from '../actions';
import { errorCopy } from '../messages';

export const metadata: Metadata = { referrer: 'no-referrer' };

type SP = Record<string, string | string[] | undefined>;

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const tokenHash = typeof sp.token_hash === 'string' ? sp.token_hash : '';
  const type = sp.type === 'recovery' || sp.type === 'invite' ? sp.type : undefined;
  return tokenHash && tokenHash.length <= 256 && type ? (
    <ConfirmLanding action={confirmTokenAction} tokenHash={tokenHash} type={type} />
  ) : (
    <div className="lims-auth-card" role="alert">
      <p>{errorCopy({ code: 'auth.reset_token_invalid' })}</p>
      <a href="/auth/login">Back to sign in</a>
    </div>
  );
}

// /auth/confirm landing (AC-A7.2, AC-A8.2). The one-time link token must not leak via Referer.
import type { Metadata } from 'next';
import { ConfirmLanding } from '@/features/admin/auth/ConfirmLanding';
import { confirmTokenAction } from '@/features/admin/auth/actions';
import { errorCopy } from '@/features/admin/auth/messages';

export const metadata: Metadata = { referrer: 'no-referrer' };

type SP = Record<string, string | string[] | undefined>;

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const tokenHash = typeof sp.token_hash === 'string' ? sp.token_hash : '';
  const type = sp.type === 'recovery' || sp.type === 'invite' ? sp.type : undefined;
  return (
    <main>
      {tokenHash && tokenHash.length <= 256 && type ? (
        <ConfirmLanding action={confirmTokenAction} tokenHash={tokenHash} type={type} />
      ) : (
        <div className="lims-auth-card" role="alert">
          <p>{errorCopy({ code: 'auth.reset_token_invalid' })}</p>
          <a href="/auth/forgot">Forgot password</a>
        </div>
      )}
    </main>
  );
}

// PA-1 Sign in (public). `next` is re-validated by loginPartnerAction; `reason` is only compared, never rendered (REQ-SEC-088).
import { PurgeBrowserState } from '@/core/pwa';
import { LoginForm } from '../_components/LoginForm';
import { loginPartnerAction } from '../actions';
import { safeNext } from '../safe-next';

type SP = Record<string, string | string[] | undefined>;

export default async function LoginPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  return (
    <>
      <PurgeBrowserState />
      <LoginForm action={loginPartnerAction} sessionEnded={sp.reason === 'session'} {...(next !== '/' ? { next } : {})} />
    </>
  );
}

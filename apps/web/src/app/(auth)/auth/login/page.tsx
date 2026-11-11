// AU-1 Login (public). `next` is re-validated against routes.yaml by loginStaffAction before it is honoured.
import { LoginForm } from '@/features/admin/auth/LoginForm';
import { loginStaffAction } from '@/features/admin/auth/actions';

type SP = Record<string, string | string[] | undefined>;

export default async function LoginPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const next = typeof sp.next === 'string' && /^\/[A-Za-z0-9\-._~/]{0,511}$/.test(sp.next) ? sp.next : undefined;
  return (
    <main>
      <LoginForm action={loginStaffAction} loggedOut={sp.logged_out === '1'} mfaFailed={sp.mfa_failed === '1'} {...(next ? { next } : {})} />
    </main>
  );
}

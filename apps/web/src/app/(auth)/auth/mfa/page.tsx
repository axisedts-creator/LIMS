// AU-2 MFA challenge (session mfa_pending; the API rejects other states).
import { MfaChallengeForm } from '@/features/admin/auth/MfaChallengeForm';
import { logoutAction, verifyMfaAction } from '@/features/admin/auth/actions';

export default function MfaPage() {
  return (
    <main>
      <MfaChallengeForm action={verifyMfaAction} logoutAction={logoutAction} />
    </main>
  );
}

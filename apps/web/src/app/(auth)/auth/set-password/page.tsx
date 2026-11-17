// AU-5 Set password (session password_setup; the API enforces the state).
import { SetPasswordForm } from '@/features/admin/auth/SetPasswordForm';
import { setPasswordAction } from '@/features/admin/auth/actions';

export default function SetPasswordPage() {
  // [CONV] the core ShellSession does not carry `state`/tenant display name yet, so the recovery copy is used.
  return (
    <main>
      <SetPasswordForm action={setPasswordAction} variant="recovery" />
    </main>
  );
}

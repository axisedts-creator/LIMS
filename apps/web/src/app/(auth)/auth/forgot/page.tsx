// AU-4 Forgot password (public).
import { ForgotPasswordForm } from '@/features/admin/auth/ForgotPasswordForm';
import { requestRecoveryAction } from '@/features/admin/auth/actions';

export default function ForgotPage() {
  return (
    <main>
      <ForgotPasswordForm action={requestRecoveryAction} />
    </main>
  );
}

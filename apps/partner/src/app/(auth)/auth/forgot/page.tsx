// PA-4 Forgot password (public).
import { ForgotPasswordForm } from '../_components/ForgotPasswordForm';
import { requestRecoveryAction } from '../actions';

export default function ForgotPage() {
  return <ForgotPasswordForm action={requestRecoveryAction} />;
}

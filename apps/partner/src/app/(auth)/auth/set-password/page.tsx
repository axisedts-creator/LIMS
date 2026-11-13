// PA-6 Set password (session password_setup; the API enforces the state).
import { SetPasswordForm } from '../_components/SetPasswordForm';
import { setPasswordAction } from '../actions';

export default function SetPasswordPage() {
  return <SetPasswordForm action={setPasswordAction} />;
}

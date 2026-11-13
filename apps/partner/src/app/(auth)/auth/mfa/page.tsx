// PA-2 MFA challenge (session mfa_pending; the API enforces the state).
import { MfaChallengeForm } from '../_components/MfaChallengeForm';
import { logoutAction, verifyMfaAction } from '../actions';

export default function MfaPage() {
  return <MfaChallengeForm action={verifyMfaAction} logoutAction={logoutAction} />;
}

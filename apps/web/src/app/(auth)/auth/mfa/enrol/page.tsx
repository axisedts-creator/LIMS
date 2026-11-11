// AU-3 forced MFA enrolment (session mfa_enrolment_required). Voluntary enrolment lives in ME-1.
import { MfaEnrolment } from '@/features/admin/auth/MfaEnrolment';
import { completeMfaEnrolmentAction, startMfaEnrolmentAction } from '@/features/admin/auth/actions';

export default function MfaEnrolPage() {
  return (
    <main>
      <MfaEnrolment startAction={startMfaEnrolmentAction} completeAction={completeMfaEnrolmentAction} forced />
    </main>
  );
}

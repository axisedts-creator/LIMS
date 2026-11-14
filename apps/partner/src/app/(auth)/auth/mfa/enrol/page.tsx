// PA-3 forced MFA enrolment (session mfa_enrolment_required, US-02.7). Voluntary enrolment lives in PX-1.
import { MfaEnrolment } from '../../_components/MfaEnrolment';
import { completeMfaEnrolmentAction, startMfaEnrolmentAction } from '../../actions';

export default function MfaEnrolPage() {
  return <MfaEnrolment startAction={startMfaEnrolmentAction} completeAction={completeMfaEnrolmentAction} />;
}

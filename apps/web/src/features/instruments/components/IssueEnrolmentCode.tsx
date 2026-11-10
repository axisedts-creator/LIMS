'use client';
// SCR-03 (04-UI-UX §3, 03-APP-FLOW F-03): ConfirmDialog → E14 once → non-dismissable SecretRevealOnce.
// The code lives only in component state; it is dropped on Done and never stored, logged or put in a URL (AC-01.3).
import { useEffect, useRef, useState } from 'react';
import { shortcuts } from '@/core/shortcuts/registry';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { SecretRevealOnce } from '@lims/ui/components/SecretRevealOnce';
import { useToast } from '@lims/ui/components/Toast';
import { issueEnrolmentCodeAction } from '../server/actions';
import type { EnrolmentCodeIssued } from '../server/types';

export function IssueEnrolmentCode({ agentId, queueDepth = 0 }: { agentId: string; queueDepth?: number }) {
  const toast = useToast();
  const [step, setStep] = useState<'closed' | 'confirm' | 'reveal'>('closed');
  const [mfa, setMfa] = useState(false);
  const [issued, setIssued] = useState<EnrolmentCodeIssued | null>(null);
  const inFlight = useRef(false); // one POST per confirm: a second code would invalidate the first (E14)
  // SCR-02 Alt+E (04-UI-UX §4). Rendered only for instruments.agent.manage, so READ never registers it. Opens the confirm only.
  useEffect(() => shortcuts.register('staff.instruments.agent', { key: 'Alt+E', description: 'Issue enrolment code', run: () => setStep((s) => (s === 'closed' ? 'confirm' : s)) }), []);

  const close = () => {
    setIssued(null);
    setMfa(false);
    setStep('closed');
  };

  const issue = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await issueEnrolmentCodeAction(agentId);
      if (r.ok) {
        setIssued(r.data);
        setStep('reveal');
      } else if (r.code === 'auth.mfa_required') {
        setMfa(true);
      } else {
        close();
        toast.show({ tone: 'danger', title: 'Could not issue the enrolment code', description: r.code });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // [CONV] the agent enrols against this BFF origin; the browser never sees the API origin (REQ-SEC-068).
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <>
      <Button onPress={() => setStep('confirm')}>Issue enrolment code</Button>
      <ConfirmDialog
        title="Issue enrolment code"
        isOpen={step === 'confirm'}
        confirmLabel="Issue code"
        onCancel={close}
        onConfirm={issue}
        body={
          <>
            {mfa ? <Banner tone="warning" title="Confirm with your authenticator to continue" /> : null}
            <p>A one-time code lets one PC enrol as this agent. It expires in 24 hours. Earlier unused codes stop working.</p>
            {queueDepth > 0 ? (
              <p>This agent still has {queueDepth} messages waiting. Re-enrolling another PC will stop this PC from uploading them.</p>
            ) : null}
          </>
        }
      />
      {issued ? (
        <Dialog title="Enrolment code issued" isOpen={step === 'reveal'} isDismissable={false} onClose={() => {}}>
          <SecretRevealOnce label="Enrolment code" secret={issued.enrolment_code} expiresAt={issued.expires_at} requireAcknowledgement onAcknowledged={close} />
          <p className="lims-description">
            Paste this into the installer on the lab PC: <code className="lims-mono">bridge-agent install --server {origin} --enrolment-code {issued.enrolment_code}</code>
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

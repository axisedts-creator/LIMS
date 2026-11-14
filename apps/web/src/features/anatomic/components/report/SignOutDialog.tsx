'use client';
// 04-UI-UX §4.2.7 Sign-out Dialog: "Version {n} will be created and sent to lab verification for: {tests}.", critical finding Yes/No, the attestation Checkbox (required).
// Privileged action (anatomic.case.signout at aal2): the step-up and every failure are handled by the caller. A revision or amendment draft carries its reason already, so no
// reason is asked here (AC-10.8). LD-140 (2026-11-13, binding): kit components only; the confirm button is the primary one only while the dialog is open.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';

export function SignOutDialog({ isOpen, versionNo, tests, critical, kindLabel, onCancel, onConfirm }: {
  isOpen: boolean; versionNo: number; tests: readonly string[]; critical: boolean; kindLabel: string; onCancel: () => void; onConfirm: () => Promise<void> | void;
}) {
  const [attested, setAttested] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false); // one request per click burst (a double click must not sign twice)

  useEffect(() => {
    if (isOpen) {
      setAttested(false);
      setMissing(false);
    }
  }, [isOpen]);

  const confirm = async () => {
    if (inFlight.current) return;
    if (!attested) return setMissing(true);
    inFlight.current = true;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title="Sign out report"
      size="md"
      isOpen={isOpen}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onPress={onCancel} isDisabled={pending}>Cancel</Button>
          <Button variant="primary" isLoading={pending} onPress={() => void confirm()}>Sign out</Button>
        </>
      }
    >
      <p>Version {versionNo} will be created and sent to lab verification for: {tests.length ? tests.join(', ') : 'no active tests'}.</p>
      <p>Report type: {kindLabel}</p>
      <p>Critical finding: {critical ? 'Yes' : 'No'}</p>
      <Checkbox label="I have reviewed this report and its images" name="attest" description="Required before you can sign out." isSelected={attested} onChange={(v) => { setAttested(v); setMissing(false); }} />
      {missing ? <p className="lims-error">Tick the box to confirm you have reviewed the report.</p> : null}
    </Dialog>
  );
}

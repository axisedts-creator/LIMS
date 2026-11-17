'use client';
// SCR-07 Publish dialog (F-03, AC-03.1/03.3/03.5/03.6): one request publishes the analyte version together with its range/critical drafts.
// Privileged: needs catalog.reference_range.publish AND catalog.test.manage. If-Match + Idempotency-Key; a 403 auth.mfa_required
// asks for step-up and the retry re-sends the SAME key (same body → same key; a changed body gets a new key).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { publishAnalyteVersionAction } from '../server/actions';
import type { PublishBody } from '../server/types';
import { errAt, fmtDateTime, FailBanner, GatedButton, newKey, PERM, type Fail } from './shared';

interface Draft { id: string; version_no: number; version: number }

export function PublishDialog({ analyte, version, rangeDraft, criticalDraft, unitOrMethodChanged, permissions, isOpen, onClose }: {
  analyte: { id: string; code: string; name: string };
  version: { id: string; version_no: number; version: number };
  rangeDraft?: Draft | undefined;
  criticalDraft?: Draft | undefined;
  unitOrMethodChanged: boolean;
  permissions: readonly string[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [from, setFrom] = useState(() => new Date().toISOString());
  const touched = useRef(false);
  const [reason, setReason] = useState('');
  const [withRange, setWithRange] = useState(true);
  const [withCritical, setWithCritical] = useState(true);
  const [withoutRanges, setWithoutRanges] = useState(false);
  const [fail, setFail] = useState<Fail>();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ sig: string; key: string; from: string }>(null);

  const missing = [PERM.publish, PERM.manage].filter((p) => !permissions.includes(p));
  const needsAck = unitOrMethodChanged && !rangeDraft;
  const blocked = needsAck && !withoutRanges;
  const includeRange = !!rangeDraft && (withRange || unitOrMethodChanged);

  const submit = async () => {
    if (busy) return;
    const rest = {
      change_reason: reason,
      ...(includeRange ? { reference_range_set_id: rangeDraft!.id } : {}),
      ...(criticalDraft && withCritical ? { critical_limit_set_id: criticalDraft.id } : {}),
      ...(needsAck && withoutRanges ? { allow_without_ranges: true } : {}),
    };
    const sig = JSON.stringify({ ...rest, from: touched.current ? from : null });
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: newKey(), from: touched.current ? from : new Date().toISOString() };
    const { key, from: effective_from } = attempt.current;
    const body: PublishBody = { effective_from, ...rest };
    setBusy(true);
    try {
      const r = await publishAnalyteVersionAction(version.id, version.version, body, key);
      if (r.ok) {
        attempt.current = null;
        toast.show({ tone: 'success', title: `${analyte.code} version ${version.version_no} published, effective ${fmtDateTime(r.data.effective_from ?? effective_from)}` });
        onClose();
        router.refresh();
      } else setFail(r);
    } finally {
      setBusy(false);
    }
  };

  const fromError = errAt(fail, '/effective_from');
  const reasonError = errAt(fail, '/change_reason');
  return (
    <Dialog title={`Publish ${analyte.code} version ${version.version_no}`} isOpen={isOpen} onClose={onClose} size="md">
      <Form onSubmit={submit} errorSummary={false}>
        {fail ? <FailBanner fail={fail} /> : null}
        {needsAck ? <Banner tone="warning" title="Unit or method changed: the old reference ranges will no longer apply." /> : null}
        <DateTimePicker label="Effective from" name="effective_from" value={from as never} {...(fromError ? { error: fromError } : {})} onChange={(v) => { if (v) { touched.current = true; setFrom(v); } }} />
        <TextArea label="Change reason" name="change_reason" maxLength={500} isRequired value={reason} onChange={setReason} {...(reasonError ? { error: reasonError } : {})} />
        {rangeDraft ? (
          <Checkbox label={`Also publish reference-range draft (version ${rangeDraft.version_no})`} isSelected={includeRange} isDisabled={unitOrMethodChanged} onChange={setWithRange} />
        ) : null}
        {criticalDraft ? <Checkbox label={`Also publish critical-limit draft (version ${criticalDraft.version_no})`} isSelected={withCritical} onChange={setWithCritical} /> : null}
        {needsAck ? <Checkbox label="Publish without reference ranges" isSelected={withoutRanges} onChange={setWithoutRanges} /> : null}
        <p>Requires two-step verification</p>
        <div className="lims-inline catalog-gap-2 catalog-end">
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <GatedButton type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy} missing={missing} {...(blocked ? { isDisabled: true } : {})}>Publish</GatedButton>
        </div>
      </Form>
    </Dialog>
  );
}

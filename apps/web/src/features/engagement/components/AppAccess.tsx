'use client';
// C16.T-L1 W8 Patient app access (04-UI-UX W8; 03-APP-FLOW W8; 02-TRD §4.3.1 step 5; US-EN-03.1 / 03.6 / 06.6). Kit components and token classes only (LD-140).
// Props are injected; no fetch here — `actions` are the BFF server actions. The plaintext code lives only in IssueDialog state and is
// dropped when the dialog closes (07-SECURITY L1: shown once, never in URLs, storage, logs or attributes). The slip has no patient name.
import { useState, type ComponentProps } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PrintFrame } from '@lims/ui/components/PrintFrame';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextField } from '@lims/ui/components/TextField';
import { TokenSlip } from '@lims/ui/components/TokenSlip';

type Relationship = 'self' | 'child' | 'parent' | 'spouse' | 'sibling' | 'other';
export type AppLink = {
  profile_id: string; link_id: string; patient_id: string; display_name: string; relationship: Relationship; method: 'link_code' | 'report_link' | 'self_registered';
  status: 'active' | 'pending' | 'suspended' | 'revoked'; account_phone_masked: string; history_from?: string; patient_code?: string;
  suspend_reason?: string; revoked_at?: string; revoked_reason_code?: string;
  /** Not in the AppLink contract yet (open point: L4 needs If-Match). */
  version?: number;
};
export type LinkCodeRow = { link_code_id: string; status: 'issued' | 'redeemed' | 'revoked'; expires_at: string; issued_at: string };
export type IssueBody = {
  patient_id: string; relationship: Relationship; consented_by: 'patient' | 'guardian'; identity_check_method: 'photo_id' | 'guardian_photo_id' | 'known_patient';
  bind_phone: 'record' | 'other'; phone_e164?: string;
};
export type IssuedCode = { link_code_id: string; code: string; expires_at: string; bound_phone_masked: string };
export interface AppAccessActions {
  issue(body: IssueBody): Promise<IssuedCode>;
  revokeLink(link: AppLink, body: { reason_code: string }): Promise<void>;
  revokeCode(code: LinkCodeRow): Promise<void>;
  refresh(): Promise<void>;
}
export interface AppAccessProps {
  patient: { id: string; display_name: string; patient_code?: string };
  links: readonly AppLink[];
  codes: readonly LinkCodeRow[];
  recordPhoneMasked: string | null;
  consent: { version: string; text: string } | null;
  labName: string;
  actions: AppAccessActions;
}

type Tone = NonNullable<ComponentProps<typeof StatusChip>['tone']>;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const RELATIONSHIPS: readonly { value: Relationship; label: string }[] = [
  { value: 'self', label: 'Self' }, { value: 'child', label: 'Child' }, { value: 'parent', label: 'Parent' },
  { value: 'spouse', label: 'Spouse' }, { value: 'sibling', label: 'Sibling' }, { value: 'other', label: 'Other' },
];
const REL_LABEL = Object.fromEntries(RELATIONSHIPS.map((r) => [r.value, r.label])) as Record<string, string>;
const METHOD: Record<string, string> = { link_code: 'App code', report_link: 'Report link', self_registered: 'Self-registered' };
const LINK_STATUS: Record<string, [Tone, string]> = { active: ['success', 'Active'], pending: ['info', 'Pending'], suspended: ['warning', 'Paused'], revoked: ['neutral', 'Revoked'] };
const CODE_STATUS: Record<string, [Tone, string]> = { issued: ['info', 'Issued'], redeemed: ['success', 'Redeemed'], revoked: ['neutral', 'Revoked'] };
const SUSPEND: Record<string, string> = {
  phone_mismatch: 'phone number changed', patient_merged: 'patient records merged', patient_anonymised: 'patient record anonymised', dormant: 'not used for a long time',
};
const REVOKED: Record<string, string> = { patient_request: 'Patient request', suspected_misuse: 'Suspected misuse', staff_error: 'Staff error', account_deleted: 'Account deleted', other: 'Other' };
const REVOKE_REASONS = (['patient_request', 'suspected_misuse', 'staff_error', 'other'] as const).map((code) => ({ code, display: REVOKED[code]! }));
const PROBLEM: Record<string, string> = {
  'engagement.link_limit_reached': 'This patient already has the most app accounts or open codes allowed. Revoke one first.',
  'common.feature_disabled': 'The patient app is not turned on for this lab, or no consent text is set.',
  'common.validation_failed': 'Some details are not valid. Check the form and try again.',
  'auth.forbidden': 'You do not have permission to do this.',
  'common.version_conflict': 'This changed since the page loaded. Refresh and try again.',
  'common.not_found': 'This no longer exists. Refresh the page.',
};
const problem = (e: unknown) => {
  const x = e as { problem?: { code?: string }; code?: string } | null;
  return PROBLEM[x?.problem?.code ?? x?.code ?? ''] ?? 'Something went wrong. Try again.';
};
/** Lab zone (CV §4.8), e.g. "13 Nov 2026, 10:00". */
const KTM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const when = (iso: string) => KTM.format(new Date(iso));
const tail = (masked: string) => masked.slice(-2);
const date = (iso?: string) => (iso ? <DateText value={iso as DateTextProps['value']} withTime /> : '—');
const chip = ([tone, label]: [Tone, string]) => <StatusChip kind="generic" status={label} tone={tone} label={label} />;

/** Printed slip (04-UI-UX W8 result panel, TokenSlip variant): lab, code, expiry, phone tail, instructions — never the patient name or id. */
export function CodeSlip({ code, expiresAt, boundPhoneMasked, labName, issuedAt }: { code: string; expiresAt: string; boundPhoneMasked: string; labName: string; issuedAt?: string }) {
  const [at] = useState(() => issuedAt ?? new Date().toISOString());
  return (
    <div data-testid="code-slip">
      <TokenSlip
        labName={labName}
        heading="App code"
        big={code}
        lines={[`Valid until ${when(expiresAt)}.`, `Works once, only on the phone ending in ••${tail(boundPhoneMasked)}.`, `Open the ${labName} app → Profiles → I have a code.`]}
        issuedAt={at as ComponentProps<typeof TokenSlip>['issuedAt']}
      />
    </div>
  );
}

function IssueDialog({ patient, recordPhoneMasked, consent, labName, onIssue, onClose }: {
  patient: AppAccessProps['patient']; recordPhoneMasked: string | null; consent: AppAccessProps['consent']; labName: string;
  onIssue: AppAccessActions['issue']; onClose: (issued: boolean) => void;
}) {
  const [relationship, setRelationship] = useState<Relationship>('self');
  const [consentedBy, setConsentedBy] = useState<IssueBody['consented_by']>('patient');
  const [identity, setIdentity] = useState<IssueBody['identity_check_method']>('photo_id');
  const [bind, setBind] = useState<IssueBody['bind_phone']>(recordPhoneMasked ? 'record' : 'other');
  const [phone, setPhone] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<{ phone?: string; confirm?: string; api?: string }>({});
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ code: IssuedCode; at: string } | null>(null);
  const [printing, setPrinting] = useState(false);

  const submit = async () => {
    if (busy) return;
    const e: typeof errors = {};
    if (bind === 'other' && !E164.test(phone.trim())) e.phone = 'Enter the phone in international format, e.g. +9779800000000.';
    if (!confirmed) e.confirm = 'Confirm that you checked identity and the person agreed.';
    setErrors(e);
    if (e.phone || e.confirm) return;
    setBusy(true);
    try {
      const code = await onIssue({
        patient_id: patient.id, relationship, consented_by: consentedBy, identity_check_method: identity, bind_phone: bind, ...(bind === 'other' ? { phone_e164: phone.trim() } : {}),
      });
      setIssued({ code, at: new Date().toISOString() });
    } catch (err) {
      setErrors({ api: problem(err) });
    } finally {
      setBusy(false);
    }
  };

  if (issued) {
    const c = issued.code;
    const slip = <CodeSlip code={c.code} expiresAt={c.expires_at} boundPhoneMasked={c.bound_phone_masked} labName={labName} issuedAt={issued.at} />;
    return (
      <Dialog title="App code" isOpen onClose={() => onClose(true)} size="sm" footer={<Button variant="primary" onPress={() => setPrinting(true)}>Print slip</Button>}>
        <p>Valid until {when(c.expires_at)}. Works once, only on the phone ending in ••{tail(c.bound_phone_masked)}. Closing this window hides the code for good.</p>
        {slip}
        <PrintFrame title="App code slip" isOpen={printing} onDone={() => setPrinting(false)}>{slip}</PrintFrame>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Issue app code"
      isOpen
      onClose={() => onClose(false)}
      size="md"
      footer={<><Button variant="ghost" onPress={() => onClose(false)}>Cancel</Button><Button variant="primary" isLoading={busy} isDisabled={!consent} onPress={() => void submit()}>Issue</Button></>}
    >
      <Select label="Relationship (this patient is the app user's…)" name="relationship" options={RELATIONSHIPS} value={relationship} onChange={setRelationship}
        description="If the app account already has a 'Myself' profile, this one is added as 'Other' (the user can change it)." />
      <RadioGroup label="Consented by" name="consented_by" orientation="horizontal" value={consentedBy} onChange={setConsentedBy}
        options={[{ value: 'patient', label: 'Patient' }, { value: 'guardian', label: 'Guardian' }]} />
      <RadioGroup label="Identity check" name="identity_check_method" value={identity} onChange={setIdentity}
        options={[{ value: 'photo_id', label: 'Photo ID' }, { value: 'guardian_photo_id', label: 'Guardian photo ID' }, { value: 'known_patient', label: 'Known regular patient' }]} />
      {/* [CONV] option labels avoid the word "phone" so the group label alone names the phone choice for assistive tech. */}
      <RadioGroup label="Code works for phone" name="bind_phone" value={bind} onChange={setBind}
        options={[
          { value: 'record', label: recordPhoneMasked ? `On record ${recordPhoneMasked}` : 'On record (none)', isDisabled: !recordPhoneMasked },
          { value: 'other', label: 'Another number' },
        ]} />
      {bind === 'other' ? (
        <TextField label="Other phone number" name="phone_e164" inputMode="tel" autoComplete="off" maxLength={16} value={phone} onChange={setPhone} isRequired {...(errors.phone ? { error: errors.phone } : {})} />
      ) : null}
      {errors.phone ? <p role="alert" className="lims-error">{errors.phone}</p> : null}
      {consent ? (
        <section aria-label="Consent text">
          <p>{consent.text}</p>
          <p className="lims-description">Consent text version {consent.version}</p>
        </section>
      ) : <p role="alert" className="lims-error">{PROBLEM['common.feature_disabled']}</p>}
      <Checkbox label="I checked the person's identity and they agreed to app access" isSelected={confirmed} onChange={setConfirmed} />
      {errors.confirm ? <p role="alert" className="lims-error">{errors.confirm}</p> : null}
      {errors.api ? <p role="alert" className="lims-error">{errors.api}</p> : null}
    </Dialog>
  );
}

export function AppAccess({ patient, links, codes, recordPhoneMasked, consent, labName, actions }: AppAccessProps) {
  const [issuing, setIssuing] = useState(false);
  const [revokingLink, setRevokingLink] = useState<AppLink>();
  const [revokingCode, setRevokingCode] = useState<LinkCodeRow>();
  const [failure, setFailure] = useState<string>();

  const closeIssue = (issued: boolean) => {
    setIssuing(false);
    if (issued) void actions.refresh();
  };
  const linkStatus = (l: AppLink) => {
    const [tone, word] = LINK_STATUS[l.status] ?? ['neutral', l.status];
    const why = l.status === 'suspended' && l.suspend_reason ? SUSPEND[l.suspend_reason] : l.status === 'revoked' && l.revoked_reason_code ? REVOKED[l.revoked_reason_code] : undefined;
    return chip([tone, why ? `${word}: ${why}` : word]);
  };

  return (
    <div className="lims-app-access">
      <p>{patient.display_name}{patient.patient_code ? ` · ${patient.patient_code}` : ''}</p>
      <Button variant="primary" onPress={() => setIssuing(true)}>Issue app code</Button>
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
      {links.length === 0 && codes.length === 0 ? (
        <EmptyState title="This patient has no app access" body="Issue an app code so the patient or a guardian can see reports in the app." />
      ) : (
        <>
          <DataTable
            caption="App accounts linked"
            rows={[...links]}
            getRowId={(l) => l.link_id}
            emptyState={{ title: 'No app accounts linked.' }}
            columns={[
              { id: 'phone', header: 'Phone', isRowHeader: true, cell: (l) => l.account_phone_masked },
              { id: 'rel', header: 'Relationship', cell: (l) => REL_LABEL[l.relationship] ?? l.relationship },
              { id: 'method', header: 'Method', cell: (l) => METHOD[l.method] ?? l.method },
              { id: 'status', header: 'Status', cell: linkStatus },
              { id: 'since', header: 'Since', cell: (l) => date(l.history_from) },
              { id: 'revoke', header: 'Revoke', cell: (l) => (l.status === 'active' || l.status === 'suspended' ? <Button size="sm" variant="danger" onPress={() => setRevokingLink(l)}>Revoke</Button> : null) },
            ]}
          />
          <DataTable
            caption="Codes"
            rows={[...codes]}
            getRowId={(c) => c.link_code_id}
            emptyState={{ title: 'No codes issued.' }}
            columns={[
              { id: 'issued', header: 'Issued', isRowHeader: true, cell: (c) => date(c.issued_at) },
              { id: 'expires', header: 'Expires', cell: (c) => date(c.expires_at) },
              { id: 'status', header: 'Status', cell: (c) => chip(CODE_STATUS[c.status] ?? ['neutral', c.status]) },
              { id: 'revoke', header: 'Revoke', cell: (c) => (c.status === 'issued' ? <Button size="sm" variant="danger" onPress={() => setRevokingCode(c)}>Revoke code</Button> : null) },
            ]}
          />
        </>
      )}
      {issuing ? <IssueDialog patient={patient} recordPhoneMasked={recordPhoneMasked} consent={consent} labName={labName} onIssue={actions.issue} onClose={closeIssue} /> : null}
      {revokingLink ? (
        <ConfirmDialog
          title="Revoke app access?"
          body={<p>The app account with phone {revokingLink.account_phone_masked} stops seeing this patient's reports.</p>}
          confirmLabel="Revoke access"
          tone="danger"
          isOpen
          onCancel={() => setRevokingLink(undefined)}
          requireReason={{ codedSet: 'app_link_revoke_reasons', options: REVOKE_REASONS }}
          onConfirm={async ({ reasonCode }) => {
            if (!reasonCode) return;
            try {
              await actions.revokeLink(revokingLink, { reason_code: reasonCode });
              setFailure(undefined);
              await actions.refresh();
            } catch (e) {
              setFailure(problem(e));
            }
            setRevokingLink(undefined);
          }}
        />
      ) : null}
      {revokingCode ? (
        <ConfirmDialog
          title="Revoke this code?"
          body={<p>The code stops working. Issue a new code if the patient still needs app access.</p>}
          confirmLabel="Revoke code"
          tone="danger"
          isOpen
          onCancel={() => setRevokingCode(undefined)}
          onConfirm={async () => {
            try {
              await actions.revokeCode(revokingCode);
              setFailure(undefined);
              await actions.refresh();
            } catch (e) {
              setFailure(problem(e));
            }
            setRevokingCode(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

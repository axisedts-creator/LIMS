'use client';
// 04-UI-UX §5 Patient page: demographics card (edit with If-Match), consents ("Update consent" dialog), visits table, Anonymise (info + gate).
// Phone is shown masked; the raw number appears only inside the edit form. All patient text is rendered as React text nodes (REQ-SEC-088).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { recordConsentAction, updatePatientAction } from '../server/actions';
import { CONSENT_TEXT_VERSION_FALLBACK, type Consents, type OrderSummary, type Patient } from '../server/types';
import { Ad, Status, errorText, hasPerm, humanize } from './format';

const FIELDS = [['full_name', 'Full name'], ['phone_e164', 'Phone'], ['email', 'Email'], ['address_text', 'Address']] as const;
type Field = (typeof FIELDS)[number][0];
const CONSENT_LABELS: readonly [keyof Omit<Consents, 'consent_text_version'>, string][] = [['processing', 'Data processing'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['share_with_referrer', 'Share with referrer']];

export function PatientView({ patient, orders, permissions }: { patient: Patient; orders: readonly OrderSummary[]; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [notice, setNotice] = useState<{ title: string; reload?: boolean }>();
  const key = useRef(crypto.randomUUID());
  const anonymised = patient.is_anonymised;
  const canWrite = !anonymised && hasPerm(permissions, 'frontdesk.registration.create');
  const canAnonymise = !anonymised && hasPerm(permissions, 'frontdesk.patient.anonymise');
  const fail = (code: string, status?: number) => setNotice({ title: errorText(code, status), reload: code === 'common.version_conflict' });

  return (
    <section aria-label="Patient">
      <PageHeader
        title={patient.full_name}
        helpKey="frontdesk.patient"
        {...(anonymised ? { status: <span>Anonymised</span> } : {})}
        actions={canWrite ? (
          <>
            <Button onPress={() => { setNotice(undefined); setEditing(true); }}>Edit demographics</Button>
            <Button onPress={() => { key.current = crypto.randomUUID(); setNotice(undefined); setConsentOpen(true); }}>Update consent</Button>
          </>
        ) : null}
      />
      {notice ? <div role="alert"><Banner tone="danger" title={notice.title} {...(notice.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} /></div> : null}

      <section aria-label="Demographics">
        <h2>Demographics</h2>
        <dl>
          <div><dt>Patient code</dt><dd>{patient.patient_code}</dd></div>
          <div><dt>Sex</dt><dd>{humanize(patient.sex)}</dd></div>
          <div><dt>Age</dt><dd>{patient.age_display}</dd></div>
          {anonymised ? null : <div><dt>Phone</dt><dd>{patient.phone_masked}</dd></div>}
        </dl>
        {editing ? <EditForm patient={patient} onClose={() => setEditing(false)} onDone={() => { setEditing(false); toast.show({ tone: 'success', title: 'Patient updated.' }); router.refresh(); }} onFail={fail} /> : null}
      </section>

      <section aria-label="Consents">
        <h2>Consents</h2>
        <ul>
          {CONSENT_LABELS.map(([k, label]) => <li key={k}>{label}: {patient.consents[k] ? 'Yes' : 'No'}</li>)}
        </ul>
        <p>Consent text version {patient.consents.consent_text_version}</p>
      </section>

      <section aria-label="Visits">
        <h2>Visits</h2>
        {orders.length === 0 ? <p>No visits yet</p> : (
          <table>
            <caption>Visits</caption>
            <thead><tr><th scope="col">Registration no</th><th scope="col">Date</th><th scope="col">Source</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><a className="lims-link" href={`/frontdesk/orders/${o.id}`}>{o.registration_no}</a></td><td><Ad value={o.registered_at} /></td><td>{humanize(o.source)}</td><td><Status status={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canAnonymise ? (
        <section aria-label="Anonymise">
          <h2>Anonymise</h2>
          <p>Personal details are removed. Orders and invoices are retained for the legal retention period. Needs MFA (aal2).</p>
          {/* ponytail: the anonymise POST (F-anonymisePatient) belongs to FD-T15; enable this button there. */}
          <Button variant="danger" isDisabled>Anonymise patient</Button>
        </section>
      ) : null}

      {consentOpen ? (
        <ConsentDialog patient={patient} idempotencyKey={key.current} onClose={() => setConsentOpen(false)} onDone={() => { setConsentOpen(false); toast.show({ tone: 'success', title: 'Consent recorded.' }); router.refresh(); }} onFail={(c, s) => { setConsentOpen(false); fail(c, s); }} />
      ) : null}
    </section>
  );
}

function EditForm({ patient, onClose, onDone, onFail }: { patient: Patient; onClose: () => void; onDone: () => void; onFail: (code: string, status?: number) => void }) {
  const initial: Record<Field, string> = { full_name: patient.full_name, phone_e164: patient.phone_e164 ?? '', email: patient.email ?? '', address_text: patient.address_text ?? '' };
  const [v, setV] = useState(initial);
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    // Only changed, non-empty fields go out (PATCH + If-Match = the row version the form was opened on).
    const changes: Record<string, string> = {};
    for (const [f] of FIELDS) if (v[f].trim() !== initial[f] && v[f].trim() !== '') changes[f] = v[f].trim();
    if (Object.keys(changes).length === 0) return onClose();
    inFlight.current = true;
    try {
      const r = await updatePatientAction(patient.id, patient.version, changes);
      if (r.ok) onDone(); else onFail(r.code, r.status);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Form onSubmit={submit}>
      {FIELDS.map(([f, label]) => <TextField key={f} label={label} name={f} isRequired={f === 'full_name'} maxLength={f === 'address_text' ? 300 : 120} value={v[f]} onChange={(x) => setV({ ...v, [f]: x })} />)}
      <Button type="submit" variant="primary">Save</Button>
      <Button variant="ghost" onPress={onClose}>Cancel</Button>
    </Form>
  );
}

function ConsentDialog({ patient, idempotencyKey, onClose, onDone, onFail }: { patient: Patient; idempotencyKey: string; onClose: () => void; onDone: () => void; onFail: (code: string, status?: number) => void }) {
  const [c, setC] = useState<Consents>({ ...patient.consents, consent_text_version: patient.consents.consent_text_version || CONSENT_TEXT_VERSION_FALLBACK });
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await recordConsentAction(patient.id, c, idempotencyKey);
      if (r.ok) onDone(); else onFail(r.code, r.status);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Dialog title="Update consent" isOpen onClose={onClose} size="md">
      <Form onSubmit={submit}>
        {CONSENT_LABELS.map(([k, label]) => <Checkbox key={k} label={label} isSelected={c[k]} onChange={(on) => setC({ ...c, [k]: on })} />)}
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Save</Button>
      </Form>
    </Dialog>
  );
}

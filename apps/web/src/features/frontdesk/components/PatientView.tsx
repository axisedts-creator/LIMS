'use client';
// 04-UI-UX §5 Patient page: demographics card (edit with If-Match), consents ("Update consent" dialog), visits table, Anonymise (info + gate).
// Phone is shown masked; the raw number appears only inside the edit form. All patient text is rendered as React text nodes (REQ-SEC-088).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
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
const VISIT_COLUMNS: ColumnDef<OrderSummary>[] = [
  { id: 'registration_no', header: 'Registration no', isRowHeader: true, cell: (o) => <a className="lims-link" href={`/frontdesk/orders/${o.id}`}>{o.registration_no}</a> },
  { id: 'date', header: 'Date', cell: (o) => <Ad value={o.registered_at} /> },
  { id: 'source', header: 'Source', cell: (o) => humanize(o.source) },
  { id: 'status', header: 'Status', cell: (o) => <Status status={o.status} /> },
];
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

      {/* T0D-UIGUARD-1-FRONTDESK (LD-436 R7, LD-439): page sections are kit Cards with a title row (region), not raw h2/ul. */}
      <Card title="Demographics" region>
        {/* T0D-UIX-4 (LD-442): label and value fields are the kit DescriptionList. */}
        <DescriptionList columns={2} items={[
          { term: 'Patient code', value: patient.patient_code },
          { term: 'Sex', value: humanize(patient.sex) },
          { term: 'Age', value: patient.age_display },
          ...(anonymised ? [] : [{ term: 'Phone', value: patient.phone_masked }]),
        ]} />
        {editing ? <EditForm patient={patient} onClose={() => setEditing(false)} onDone={() => { setEditing(false); toast.show({ tone: 'success', title: 'Patient updated.' }); router.refresh(); }} onFail={fail} /> : null}
      </Card>

      <Card title="Consents" region>
        <div role="list">
          {CONSENT_LABELS.map(([k, label]) => <div role="listitem" key={k}>{label}: {patient.consents[k] ? 'Yes' : 'No'}</div>)}
        </div>
        <p>Consent text version {patient.consents.consent_text_version}</p>
      </Card>

      <Card title="Visits" region>
        {/* LD-353 rule 5 / T0D-UIX-4 (LD-442): kit DataTable, the header stays when there are no visits. */}
        <DataTable caption="Visits" columns={VISIT_COLUMNS} rows={orders} getRowId={(o) => o.id} emptyState={{ title: 'No visits yet' }} />
      </Card>

      {canAnonymise ? (
        <Card title="Anonymise" region>
          <p>Personal details are removed. Orders and invoices are retained for the legal retention period. Needs MFA (aal2).</p>
          {/* ponytail: the anonymise POST (F-anonymisePatient) belongs to FD-T15; enable this button there. */}
          <Button variant="danger" isDisabled>Anonymise patient</Button>
        </Card>
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

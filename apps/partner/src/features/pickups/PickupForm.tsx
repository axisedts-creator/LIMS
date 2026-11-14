'use client';
// C13.T19 PK-2 Request pickup (04-UI-UX PK-2 field table; US-10.1/10.2). Only eligible manifests are offered (submitted / partly received, not on an open pickup); one primary button.
// LD-140 (2026-11-13): @lims/ui components only.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { normalisePhone } from '../manifests/LineForm';
import { createPickupAction } from './actions';

export interface EligibleManifest { id: string; manifest_no: string; centre_id?: string | undefined; centre_name?: string | undefined }
const E164 = /^\+[1-9][0-9]{7,14}$/;

export function PickupForm({ manifests, preselected }: { manifests: EligibleManifest[]; preselected: string | undefined }) {
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(preselected ? [preselected] : []));
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();
  const [boxes, setBoxes] = useState<number | undefined>(1);
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useState(() => (typeof crypto !== 'undefined' ? crypto.randomUUID() : ''))[0];

  const toggle = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  const msg = (name: string) => issues.find((i) => i.path === `/${name}`)?.message;

  const submit = async () => {
    const found: { path: string; message: string }[] = [];
    const chosen = manifests.filter((m) => picked.has(m.id));
    if (chosen.length < 1 || chosen.length > 20) found.push({ path: '/manifest_ids', message: 'Choose between 1 and 20 manifests.' });
    if (new Set(chosen.map((m) => m.centre_id ?? '')).size > 1) found.push({ path: '/manifest_ids', message: 'Choose manifests for one receiving centre.' });
    if (!from) found.push({ path: '/window_start', message: 'Enter when the pickup window starts.' });
    if (!to) found.push({ path: '/window_end', message: 'Enter when the pickup window ends.' });
    if (from && to && !(from < to)) found.push({ path: '/window_end', message: 'The window must end after it starts.' });
    if (from && Date.parse(from) < Date.now() - 3_600_000) found.push({ path: '/window_start', message: 'The window cannot start more than an hour ago.' });
    if (boxes === undefined || boxes < 1 || boxes > 50) found.push({ path: '/packages_count', message: 'Enter 1 to 50 boxes or bags.' });
    const e164 = normalisePhone(phone);
    if (phone && !E164.test(e164)) found.push({ path: '/phone', message: 'Enter the number with country code, for example +9779800000000.' });
    setIssues(found);
    if (found.length > 0 || !from || !to || boxes === undefined) return;
    setBusy(true);
    setFailed(null);
    const r = await createPickupAction({ manifest_ids: chosen.map((m) => m.id), window_start: from, window_end: to, packages_count: boxes, ...(notes ? { notes } : {}), ...(contact ? { contact_name: contact } : {}), ...(phone ? { contact_phone_e164: e164 } : {}) }, key);
    setBusy(false);
    if (r.ok) router.push('/pickups');
    else setFailed(r.code === 'partners.pickup_invalid' ? 'The lab cannot take this request. Check the window and the manifests.' : 'Could not send the request. Try again in a moment.');
  };

  return (
    <>
      <PageHeader title="Request pickup" helpKey="partners.pickup_request" />
      {failed ? <Banner tone="danger" title={failed} /> : null}
      <Form onSubmit={submit} problem={{ errors: issues }}>
        <Stack gap={4}>
          <fieldset>
            <legend>Manifests</legend>
            {manifests.length === 0 ? (
              <EmptyState title="No manifests are ready for pickup." body="Submit a manifest first." />
            ) : (
              manifests.map((m) => (
                <Checkbox key={m.id} label={m.manifest_no} name="manifest_ids" isSelected={picked.has(m.id)} onChange={(on) => toggle(m.id, on)} {...(m.centre_name ? { description: m.centre_name } : {})} />
              ))
            )}
            {msg('manifest_ids') ? <p role="alert">{msg('manifest_ids')}</p> : null}
          </fieldset>
          <DateTimePicker label="Pickup window from" name="window_start" minuteStep={15} isRequired {...(from ? { value: from as never } : {})} onChange={setFrom} {...(msg('window_start') ? { error: msg('window_start')! } : {})} />
          <DateTimePicker label="Pickup window to" name="window_end" minuteStep={15} isRequired {...(to ? { value: to as never } : {})} onChange={setTo} {...(msg('window_end') ? { error: msg('window_end')! } : {})} />
          <IntegerField label="Number of boxes/bags" name="packages_count" min={1} max={50} isRequired {...(boxes !== undefined ? { value: boxes } : {})} onChange={setBoxes} {...(msg('packages_count') ? { error: msg('packages_count')! } : {})} />
          <TextField label="Contact person" name="contact_name" maxLength={80} value={contact} onChange={setContact} />
          <TextField label="Contact phone" name="phone" maxLength={16} inputMode="tel" value={phone} onChange={setPhone} {...(msg('phone') ? { error: msg('phone')! } : {})} />
          <TextArea label="Notes" name="notes" maxLength={500} description="For example address details or the gate to use." value={notes} onChange={setNotes} />
          <div><Button type="submit" variant="primary" isLoading={busy}>Request pickup</Button></div>
        </Stack>
      </Form>
    </>
  );
}

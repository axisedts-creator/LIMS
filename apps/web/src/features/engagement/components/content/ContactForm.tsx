'use client';
// T0D-CONTENT-1 Contact Us (done_when 4): ONE form, stored as the single portal content item of kind contact (body = "Label: value" lines,
// link_url = the map link, https only) because the contract has no contact fields [CONV]. Saving updates it (If-Match) or creates it once.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { TextField } from '@lims/ui/components/TextField';
import { t } from '@/core/i18n/messages';
import { createContentAction, updateContentAction } from '../../server/content-actions';
import { LINK_MAX, bodyError, contactBody, emailError, failText, linkError, parseContact, plainError, type ContactFields, type PortalContent } from './content-model';

const FIELDS: readonly { id: keyof ContactFields; label: string; max: number; check: (v: string) => string | undefined }[] = [
  { id: 'address', label: 'engagement.content.contact.address', max: 300, check: plainError },
  { id: 'phones', label: 'engagement.content.contact.phones', max: 200, check: plainError },
  { id: 'email', label: 'engagement.content.contact.email', max: 254, check: emailError },
  { id: 'hours', label: 'engagement.content.contact.hours', max: 300, check: plainError },
  { id: 'map', label: 'engagement.content.contact.map', max: LINK_MAX, check: linkError },
];

export function ContactForm({ item, canManage, onSaved }: { item?: PortalContent | undefined; canManage: boolean; onSaved: (p: PortalContent) => void }) {
  const router = useRouter();
  const [v, setV] = useState<ContactFields>(() => parseContact(item));
  useEffect(() => setV(parseContact(item)), [item]);
  const [errors, setErrors] = useState<Partial<Record<keyof ContactFields, string>>>({});
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const e = Object.fromEntries(FIELDS.map((f) => [f.id, f.check(v[f.id].trim())]).filter(([, m]) => m)) as typeof errors;
    const body = contactBody(v);
    const bodyProblem = Object.keys(e).length ? undefined : bodyError(body);
    setErrors(e);
    if (Object.keys(e).length || bodyProblem) { setStatus(bodyProblem ? { ok: false, text: bodyProblem } : undefined); return; }
    const map = v.map.trim();
    setBusy(true);
    const r = item
      ? await updateContentAction(item.id, item.version, { body, ...(map ? { link_url: map } : {}) })
      : await createContentAction({ kind: 'contact', title: t('engagement.content.contact.title'), body, ...(map ? { link_url: map } : {}) });
    setBusy(false);
    if (r.ok) { onSaved(r.data); setStatus({ ok: true, text: t('engagement.content.state.saved') }); router.refresh(); }
    else setStatus({ ok: false, text: failText(r) });
  };

  return (
    <form className="lims-stack lims-form-narrow" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
      {FIELDS.map((f) => (
        <TextField
          key={f.id}
          label={t(f.label)}
          name={`contact_${f.id}`}
          maxLength={f.max}
          value={v[f.id]}
          isReadOnly={!canManage}
          {...(f.id === 'email' ? { inputMode: 'email' as const } : f.id === 'phones' ? { inputMode: 'tel' as const } : {})}
          {...(errors[f.id] ? { error: errors[f.id]! } : {})}
          onChange={(x) => setV((o) => ({ ...o, [f.id]: x }))}
        />
      ))}
      {status ? <p {...(status.ok ? { role: 'status' } : { role: 'alert' })} className={status.ok ? 'lims-description' : 'lims-error'}>{status.text}</p> : null}
      {canManage ? (
        <div className="lims-inline">
          <Button type="submit" variant="primary" isLoading={busy}>{t('engagement.content.form.save')}</Button>
        </div>
      ) : null}
    </form>
  );
}

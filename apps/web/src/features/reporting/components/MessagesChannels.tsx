'use client';
// 04-UI-UX §2.7 Messages & channels. Message texts (reporting.message_template.manage) and channel accounts (reporting.channel.manage).
// A channel account stores a secret REFERENCE only — never a secret value. The callback URL is shown once (E1) and never kept after the dialog closes.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { rotateCallbackTokenAction, upsertChannelAccountAction, upsertMessageTextAction } from '../server/actions';
import type { ChannelAccount, MessageTemplate, MessageText } from '../server/types';
import { Chip, errorText, hasPerm, humanize } from './format';
import { NativeSelect } from './ReasonDialog';
import { SimpleTable, type Col } from './SimpleTable';

const CHANNEL: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const PROVIDERS: Record<string, [string, string][]> = {
  whatsapp: [['whatsapp_cloud_api', 'WhatsApp Cloud API'], ['recording', 'Recording (test only)']],
  sms: [['sms_sparrow', 'Sparrow SMS'], ['sms_aakash', 'Aakash SMS'], ['recording', 'Recording (test only)']],
  email: [['email_smtp_relay', 'SMTP relay'], ['recording', 'Recording (test only)']],
};
const APPROVAL = [['draft', 'Draft'], ['submitted', 'Submitted'], ['approved', 'Approved'], ['rejected', 'Rejected']] as const;
const LANGS = [['en', 'English'], ['ne', 'Nepali']] as const;
const SECRET_REF = '^[a-z0-9_./-]{1,128}$';
const textStatus = (t: MessageText) => `${CHANNEL[t.channel] ?? t.channel}: ${t.is_active ? 'Active' : 'Draft'}`;

export interface MessagesChannelsProps { templates: readonly MessageTemplate[]; accounts: readonly ChannelAccount[]; permissions: readonly string[]; productionMode?: boolean }

export function MessagesChannels({ templates, accounts, permissions, productionMode = false }: MessagesChannelsProps) {
  const [edit, setEdit] = useState<MessageTemplate | null>(null);
  const canTexts = hasPerm(permissions, 'reporting.message_template.manage');
  const cols: Col<MessageTemplate>[] = [
    { id: 'code', header: 'Template', rowHeader: true, cell: (t) => <code>{t.code}</code> },
    { id: 'purpose', header: 'Purpose', cell: (t) => humanize(t.purpose) },
    { id: 'channels', header: 'Channels', cell: (t) => t.channels.map((c) => CHANNEL[c] ?? c).join(', ') },
    { id: 'status', header: 'Status', cell: (t) => (
      <ul className="lims-plain-list">
        {t.texts.map((x) => <li key={`${x.channel}-${x.language}`}>{textStatus(x)}{x.channel === 'whatsapp' && x.approval_status !== 'not_required' ? <> · <Chip status={x.approval_status} /></> : null}</li>)}
      </ul>
    ) },
    { id: 'act', header: 'Actions', cell: (t) => (canTexts ? <Button size="sm" onPress={() => setEdit(t)}>Edit</Button> : null) },
  ];
  return (
    <section aria-label="Messages and channels">
      <PageHeader title="Messages & channels" helpKey="reporting.messages" />
      <div className="lims-card">
        <h2>Message templates</h2>
        <SimpleTable caption="Message templates" columns={cols} rows={templates} getRowId={(t) => t.code} empty={{ title: 'No message templates yet.' }} />
      </div>
      <div className="lims-card">
        <h2>Channel accounts</h2>
        {accounts.length === 0 ? <p>No channel accounts yet.</p> : accounts.map((a) => <AccountForm key={`${a.channel}-${a.version}`} account={a} canManage={hasPerm(permissions, 'reporting.channel.manage')} productionMode={productionMode} />)}
      </div>
      {edit ? <TextDialog template={edit} onClose={() => setEdit(null)} /> : null}
    </section>
  );
}

function TextDialog({ template, onClose }: { template: MessageTemplate; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const first = template.texts[0];
  const [channel, setChannel] = useState(first?.channel ?? template.channels[0] ?? 'sms');
  const [lang, setLang] = useState(first?.language ?? 'en');
  const existing = template.texts.find((t) => t.channel === channel && t.language === lang);
  const [body, setBody] = useState(existing?.body_text ?? '');
  const [subject, setSubject] = useState(existing?.subject_text ?? '');
  const [active, setActive] = useState(existing?.is_active ?? false);
  const [approval, setApproval] = useState(existing?.approval_status ?? (channel === 'whatsapp' ? 'draft' : 'not_required'));
  const [pName, setPName] = useState(existing?.provider_template_name ?? '');
  const [pLang, setPLang] = useState(existing?.provider_template_language ?? '');
  const [pOrder, setPOrder] = useState((existing?.provider_variable_order ?? []).join(', '));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBody(existing?.body_text ?? ''); setSubject(existing?.subject_text ?? ''); setActive(existing?.is_active ?? false);
    setApproval(existing?.approval_status ?? (channel === 'whatsapp' ? 'draft' : 'not_required'));
    setPName(existing?.provider_template_name ?? ''); setPLang(existing?.provider_template_language ?? ''); setPOrder((existing?.provider_variable_order ?? []).join(', '));
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, lang]);

  const save = async () => {
    if (busy) return;
    if (body.trim() === '') { setError('Message body is required'); return; }
    const undeclared = [...body.matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1]!).filter((n) => !template.params.some((p) => p.name === n));
    if (undeclared.length) { setError(`Unknown placeholder: {${undeclared[0]}}`); return; }
    setBusy(true);
    try {
      const r = await upsertMessageTextAction(template.code, channel, existing?.version, {
        language: lang, body_text: body, approval_status: approval, is_active: active,
        ...(channel === 'email' && subject ? { subject_text: subject } : {}),
        ...(channel === 'whatsapp' ? { ...(pName ? { provider_template_name: pName } : {}), ...(pLang ? { provider_template_language: pLang } : {}), provider_variable_order: pOrder.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      });
      if (r.ok) { toast.show({ tone: 'success', title: 'Message text saved.' }); router.refresh(); onClose(); } else setError(errorText(r.code));
    } finally { setBusy(false); }
  };
  return (
    <Dialog
      title={`Edit ${template.code}`} isOpen onClose={onClose} size="lg" isDismissable={false}
      footer={<><Button variant="ghost" onPress={onClose} isDisabled={busy}>Cancel</Button><Button variant="primary" onPress={() => void save()} isLoading={busy}>Save</Button></>}
    >
      <NativeSelect label="Channel" value={channel} onChange={setChannel} options={template.channels.map((c) => ({ value: c, label: CHANNEL[c] ?? c }))} placeholder="Choose a channel" />
      <NativeSelect label="Language" value={lang} onChange={setLang} options={LANGS.map(([value, label]) => ({ value, label }))} placeholder="Choose a language" />
      {channel === 'email' ? <TextField label="Subject" name="subject_text" maxLength={150} value={subject} onChange={setSubject} /> : null}
      <TextArea label="Message body" name="body_text" maxLength={1000} rows={6} value={body} onChange={setBody} />
      <div className="lims-chip-list">
        {template.params.map((p) => <Button key={p.name} size="sm" variant="ghost" onPress={() => setBody((b) => `${b}{${p.name}}`.slice(0, 1000))}>{`Insert {${p.name}}`}</Button>)}
      </div>
      {channel === 'whatsapp' ? (
        <>
          <TextField label="Provider template name" name="provider_template_name" maxLength={128} value={pName} onChange={setPName} />
          <TextField label="Provider locale" name="provider_template_language" maxLength={16} value={pLang} onChange={setPLang} />
          <TextField label="Variable order (comma-separated)" name="provider_variable_order" maxLength={400} value={pOrder} onChange={setPOrder} />
          <NativeSelect label="Approval status" value={approval} onChange={setApproval} options={APPROVAL.map(([value, label]) => ({ value, label }))} placeholder="Choose" />
        </>
      ) : null}
      <Switch label="Active" isSelected={active} onChange={setActive} />
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
    </Dialog>
  );
}

function AccountForm({ account, canManage, productionMode }: { account: ChannelAccount; canManage: boolean; productionMode: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [provider, setProvider] = useState(account.provider_kind);
  const [sender, setSender] = useState(account.sender_id ?? '');
  const [secret, setSecret] = useState(account.secret_ref);
  const [active, setActive] = useState(account.is_active);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const inFlight = useRef(false);
  const providers = (PROVIDERS[account.channel] ?? []).filter(([v]) => !(productionMode && v === 'recording'));
  const id = `secret-${account.channel}`;

  const save = async () => {
    if (inFlight.current) return;
    if (!new RegExp(SECRET_REF).test(secret)) { setError('Use a secret reference of lowercase letters, digits and _ . / - (up to 128 characters)'); return; }
    inFlight.current = true; setBusy(true); setError(undefined);
    try {
      const r = await upsertChannelAccountAction(account.channel, { provider_kind: provider, secret_ref: secret, is_active: active, ...(sender ? { sender_id: sender } : {}) });
      if (r.ok) { toast.show({ tone: 'success', title: `${CHANNEL[account.channel] ?? account.channel} account saved.` }); router.refresh(); } else setError(errorText(r.code));
    } finally { inFlight.current = false; setBusy(false); }
  };
  const generate = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await rotateCallbackTokenAction(account.channel, account.version);
      if (r.ok) setUrl(r.data.callback_url); else setError(errorText(r.code));
    } finally { inFlight.current = false; }
  };
  return (
    <div className="lims-subcard">
      <h3>{CHANNEL[account.channel] ?? account.channel}</h3>
      <NativeSelect label="Provider" value={provider} onChange={setProvider} options={providers.map(([value, label]) => ({ value, label }))} placeholder="Choose a provider" />
      <TextField label="Sender ID" name={`sender_${account.channel}`} maxLength={64} value={sender} isReadOnly={!canManage} onChange={setSender} />
      <div className="lims-field">
        <label className="lims-label" htmlFor={id}>Secret reference</label>
        <input id={id} name={id} className="lims-input" pattern={SECRET_REF} maxLength={128} value={secret} readOnly={!canManage} onChange={(e) => setSecret(e.currentTarget.value)} aria-describedby={`${id}-d`} />
        <p id={`${id}-d`} className="lims-description">Name of the secret your operator stored. The secret itself is never entered here.</p>
      </div>
      <Switch label={`${CHANNEL[account.channel] ?? account.channel} account is active`} isDisabled={!canManage} isSelected={active} onChange={setActive} />
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
      {canManage ? (
        <div className="lims-action-bar">
          <Button variant="primary" isLoading={busy} onPress={() => void save()}>Save account</Button>
          <Button onPress={() => void generate()}>Generate callback URL</Button>
        </div>
      ) : null}
      <Dialog
        title="Callback URL" isOpen={url !== null} onClose={() => setUrl(null)} size="md" isDismissable={false}
        footer={<><Button onPress={() => { if (url) void navigator.clipboard?.writeText(url); }}>Copy URL</Button><Button variant="primary" onPress={() => setUrl(null)}>Done</Button></>}
      >
        <p>Copy this URL into the provider&apos;s settings. It will not be shown again.</p>
        <code className="lims-mono">{url}</code>
      </Dialog>
    </div>
  );
}

'use client';
// T0D-MSGDESK-1 (LD-321, LD-310, LD-353 template 1 LIST): ElabAssist Messages > Create New Template. Columns Name, Channel, Active.
// Add (name, channel, subject for Email, message with the placeholder helper), Edit (only the changed fields; the channel is fixed at creation) and
// Deactivate (there is no Activate operation). Plain text only: a body is shown and sent as text, never as markup (ST16).
// Blocked controls are disabled and point (aria-describedby) at the one visible reason line that names the permission code.
// Shared parts of the message screens (Gate, ReasonLine, msgRefusal) live here and are used by Broadcasts.tsx.
import { useId, useState, type ReactNode } from 'react';
import { Button, type ButtonProps } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { hasPerm } from '@/features/partners/components/common';
import { Alert, ConfirmWrite, SalesTable, failure, newKey, useOnce, useUrl, type Col } from '@/features/partners/components/SalesCommon';
import type { BroadcastTemplate, Channel } from '../server/broadcast.server';
import { createTemplateAction, deactivateTemplateAction, updateTemplateAction, type MsgResult } from '../server/broadcastActions';

export const MANAGE = 'engagement.broadcast.manage';
export const APPROVE = 'engagement.broadcast.approve';
const CHANNELS: readonly Channel[] = ['sms', 'whatsapp', 'email'];
/** The closed placeholder list (engagement.yaml BroadcastPlaceholder): the helper offers exactly these. */
export const PLACEHOLDERS = ['party_name', 'lab_name', 'lab_phone', 'send_date'] as const;
const USED = /\{\{\s*([^}]*?)\s*\}\}/g;
export const channelText = (c: string) => t(`engagement.msg.channel.${c}`);

/** Catalogue text for the refusals the message screens can meet; other codes fall back to the field / generic text. */
const CODES: Record<string, string> = {
  'engagement.broadcast_provider_not_configured': 'engagement.msg.error.provider_not_configured',
  'engagement.broadcast_self_approval': 'engagement.msg.error.self_approval',
  'engagement.broadcast_recipient_limit': 'engagement.msg.error.recipient_limit',
  'engagement.broadcast_template_inactive': 'engagement.msg.error.template_inactive',
  'engagement.broadcast_invalid_transition': 'engagement.msg.error.invalid_transition',
  'common.version_conflict': 'engagement.msg.error.version_conflict',
};
export function msgRefusal(r: Exclude<MsgResult, { ok: true }>, fields: readonly string[] = []): { fields: Record<string, string>; text?: string } {
  const key = CODES[r.code];
  if (key) return { fields: {}, text: t(key) };
  return failure(r, fields);
}

/** A button that is disabled while `reasonId` is set and then points at that visible reason line. */
export function Gate({ reasonId, children, ...props }: ButtonProps & { reasonId?: string | undefined }) {
  return (
    <Button {...props} {...(reasonId ? { isDisabled: true } : {})}
      ref={(el: HTMLButtonElement | null) => { if (!el) return; if (reasonId) el.setAttribute('aria-describedby', reasonId); else el.removeAttribute('aria-describedby'); }}>
      {children}
    </Button>
  );
}
export const ReasonLine = ({ id, children }: { id: string; children: ReactNode }) => <p id={id} className="lims-description">{children}</p>;

function TemplateDialog({ row, onClose, onDone }: { row?: BroadcastTemplate | undefined; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(row?.name ?? '');
  const [channel, setChannel] = useState<Channel | undefined>(row?.channel);
  const [subject, setSubject] = useState(row?.subject ?? '');
  const [body, setBody] = useState(row?.body ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const once = useOnce();
  const hintId = useId();

  const save = () => once(async () => {
    const e: Record<string, string> = {};
    const n = name.trim();
    const s = subject.trim();
    if (!n || n.length > 120) e['name'] = t('engagement.msg.error.name');
    if (!channel) e['channel'] = t('engagement.msg.error.check');
    if (channel === 'email' && s.length > 150) e['subject'] = t('engagement.msg.error.subject');
    if (!body.trim() || body.length > 1000) e['body'] = t('engagement.msg.error.body');
    else if ([...body.matchAll(USED)].some((m) => !(PLACEHOLDERS as readonly string[]).includes(m[1]!))) e['body'] = t('engagement.msg.error.unknown_name');
    setErrors(e);
    setText(Object.keys(e).length ? t('engagement.msg.error.check') : undefined);
    if (Object.keys(e).length || !channel) return;
    let r: MsgResult;
    setBusy(true);
    try {
      if (row) {
        const change: Record<string, string> = {};
        if (n !== row.name) change['name'] = n;
        if (body !== row.body) change['body'] = body;
        if (channel === 'email' && s && s !== (row.subject ?? '')) change['subject'] = s;
        if (Object.keys(change).length === 0) return onClose();
        r = await updateTemplateAction(row.id, row.version, change);
      } else {
        r = await createTemplateAction({ name: n, channel, ...(channel === 'email' && s ? { subject: s } : {}), body }, key);
      }
    } finally {
      setBusy(false);
    }
    if (r.ok) return onDone();
    const f = r.code === 'engagement.broadcast_placeholder_unknown' ? { fields: { body: t('engagement.msg.error.unknown_name') } } : msgRefusal(r, ['name', 'subject', 'body']);
    setErrors(f.fields);
    setText('text' in f ? f.text : undefined);
  });

  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  return (
    <Dialog title={t(row ? 'engagement.msg.edit_template' : 'engagement.msg.add_template')} isOpen onClose={onClose} size="md"
      footer={<><Button variant="ghost" onPress={onClose}>{t('engagement.msg.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('engagement.msg.save')}</Button></>}>
      <div className="lims-stack">
        <TextField label={t('engagement.msg.field.name')} name="name" maxLength={120} isRequired value={name} onChange={setName} {...err('name')} />
        {row ? (
          <p className="lims-description">{`${channelText(row.channel)}. ${t('engagement.msg.channel_fixed')}`}</p>
        ) : (
          <Select<Channel> label={t('engagement.msg.field.channel')} name="channel" isRequired options={CHANNELS.map((c) => ({ value: c, label: channelText(c) }))}
            {...(channel ? { value: channel } : {})} onChange={setChannel} {...err('channel')} />
        )}
        {channel === 'email' ? <TextField label={t('engagement.msg.field.subject')} name="subject" maxLength={150} value={subject} onChange={setSubject} {...err('subject')} /> : null}
        <TextArea label={t('engagement.msg.field.message')} name="body" maxLength={1000} rows={5} isRequired value={body} onChange={setBody} {...err('body')} />
        <div className="lims-stack" role="group" aria-label={t('engagement.msg.insert')} aria-describedby={hintId}>
          <p id={hintId} className="lims-description">{t('engagement.msg.insert_hint')}</p>
          <span className="lims-inline">
            {PLACEHOLDERS.map((p) => (
              <Button key={p} size="sm" variant="ghost" onPress={() => setBody((b) => `${b}{{${p}}}`)}>{`{{${p}}}`}</Button>
            ))}
          </span>
        </div>
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export function MessageTemplates({ rows, permissions, filter, failed, nextCursor }: {
  rows: readonly BroadcastTemplate[]; permissions: readonly string[]; filter: { channel?: string | undefined; is_active?: string | undefined };
  failed?: string | undefined; nextCursor?: string | undefined;
}) {
  const toast = useToast();
  const url = useUrl();
  const reasonId = useId();
  const blocked = hasPerm(permissions, MANAGE) ? undefined : reasonId;
  const [editing, setEditing] = useState<BroadcastTemplate | 'new' | null>(null);
  const [leaving, setLeaving] = useState<BroadcastTemplate | null>(null);
  const done = (msg: string) => { setEditing(null); setLeaving(null); toast.show({ tone: 'success', title: msg }); url.refresh(); };

  const columns: Col<BroadcastTemplate>[] = [
    { id: 'name', header: t('engagement.msg.col.name'), isRowHeader: true, cell: (r) => r.name },
    { id: 'channel', header: t('engagement.msg.col.channel'), cell: (r) => channelText(r.channel) },
    { id: 'active', header: t('engagement.msg.col.active'), cell: (r) => t(r.is_active ? 'engagement.msg.yes' : 'engagement.msg.no') },
    {
      id: 'actions', header: t('engagement.msg.col.actions'),
      cell: (r) => (
        <span className="lims-inline">
          <Gate size="sm" variant="ghost" reasonId={blocked} onPress={() => setEditing(r)}>{t('engagement.msg.edit')}</Gate>
          {r.is_active ? <Gate size="sm" variant="ghost" reasonId={blocked} onPress={() => setLeaving(r)}>{t('engagement.msg.deactivate')}</Gate> : null}
        </span>
      ),
    },
  ];
  const yesNo = [{ value: 'true', label: t('engagement.msg.yes') }, { value: 'false', label: t('engagement.msg.no') }];

  return (
    <section className="lims-stack">
      <PageHeader title={t('engagement.nav.msg_templates')} helpKey="engagement.msg_templates"
        actions={<Gate variant="primary" reasonId={blocked} onPress={() => setEditing('new')}>{t('engagement.msg.add_template')}</Gate>} />
      {blocked ? <ReasonLine id={reasonId}>{t('engagement.msg.reason.manage')}</ReasonLine> : null}
      <FilterBar
        filters={[
          { id: 'channel', label: t('engagement.msg.filter.channel'), kind: 'select', options: CHANNELS.map((c) => ({ value: c, label: channelText(c) })) },
          { id: 'is_active', label: t('engagement.msg.filter.active'), kind: 'select', options: yesNo },
        ]}
        value={{ ...(filter.channel ? { channel: filter.channel } : {}), ...(filter.is_active ? { is_active: filter.is_active } : {}) }}
        onChange={(v) => url.go({ channel: v['channel'] as string | undefined, is_active: v['is_active'] as string | undefined, cursor: undefined })}
        onReset={() => url.go({ channel: undefined, is_active: undefined, cursor: undefined })}
      />
      <SalesTable caption={t('engagement.nav.msg_templates')} columns={columns} rows={rows} getRowId={(r) => r.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('engagement.msg.empty'), body: t('engagement.msg.empty_hint') }} />
      {editing ? <TemplateDialog row={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onDone={() => done(t('engagement.msg.saved'))} /> : null}
      {leaving ? (
        <ConfirmWrite title={`${t('engagement.msg.deactivate_title')}: ${leaving.name}`} body={t('engagement.msg.deactivate_body')} confirm={t('engagement.msg.deactivate')}
          act={() => deactivateTemplateAction(leaving.id, leaving.version)} onClose={() => setLeaving(null)} onDone={() => done(t('engagement.msg.deactivated'))} />
      ) : null}
    </section>
  );
}

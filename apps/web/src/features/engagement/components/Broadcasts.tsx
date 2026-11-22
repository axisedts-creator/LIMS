'use client';
// T0D-MSGDESK-1 (LD-321, LD-310, LD-353 template 1 LIST): ElabAssist Messages: audience selection, send with approval, cancel, Log page.
// Columns Template, Audience, Recipients, Status, Requested By, Approved By. The contract stores a bare user id for the requester and the approver
// (no name read exists, notes/T0D-MSGDESK-1-cr-needed.md): the cell says "You" for the signed-in user, "Another user" otherwise, an em dash when empty.
// New broadcast = the AUDIENCE BUILDER: template, party types, active only, a live recipient count (only the latest answer counts) and a masked sample.
// Nothing is sent from this screen: Save draft / Request approval only; a second person approves (LD-321) and the requester's Approve is disabled.
// History (?broadcast=<id>) lists the recipients with a masked address only.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { hasPerm } from '@/features/partners/components/common';
import { Alert, SalesTable, newKey, useOnce, useUrl, type Col } from '@/features/partners/components/SalesCommon';
import type { AudienceSample, Broadcast, BroadcastRecipient, BroadcastTemplate, PartyKind } from '../server/broadcast.server';
import {
  approveBroadcastAction, cancelBroadcastAction, createBroadcastAction, previewAudienceAction, requestApprovalAction, type MsgResult,
} from '../server/broadcastActions';
import { APPROVE, Gate, MANAGE, ReasonLine, channelText, msgRefusal } from './MessageTemplates';

const KINDS: readonly PartyKind[] = ['laboratory', 'franchise', 'client', 'lab_user'];
const STATUSES = ['draft', 'pending_approval', 'approved', 'sending', 'sent', 'cancelled'] as const;
const LIMIT = 5000; // engagement.broadcast_recipient_limit (LD-321)
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const TONES: Record<string, Tone> = { draft: 'neutral', pending_approval: 'warning', approved: 'info', sending: 'info', sent: 'success', cancelled: 'neutral', queued: 'info', failed: 'danger', skipped: 'neutral' };
const kindText = (k: string) => t(`engagement.msg.kind.${k}`);
const count = (n: number) => n.toLocaleString('en-US');
const Chip = ({ code, label }: { code: string; label: string }) => <StatusChip kind="generic" status={code} tone={TONES[code] ?? 'neutral'} label={label} />;

/** Confirm, then one write with this dialog's Idempotency-Key; a refusal stays in the dialog as catalogue text. */
function Confirm({ title, confirm, dismiss, act, onClose, onDone, danger, children }: {
  title: string; confirm: string; dismiss: string; act: (key: string) => Promise<MsgResult>; onClose: () => void; onDone: () => void; danger?: boolean; children: ReactNode;
}) {
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const once = useOnce();
  const url = useUrl();
  const go = () => once(async () => {
    setBusy(true);
    setText(undefined);
    try {
      const r = await act(key);
      if (r.ok) return onDone();
      setText(msgRefusal(r).text);
      if (r.code === 'common.version_conflict') url.refresh();
    } finally {
      setBusy(false);
    }
  });
  return (
    <Dialog title={title} isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>{dismiss}</Button><Button variant={danger ? 'danger' : 'primary'} isLoading={busy} onPress={() => void go()}>{confirm}</Button></>}>
      <div className="lims-stack">{children}<Alert text={text} /></div>
    </Dialog>
  );
}

type Preview = { state: 'idle' | 'loading' | 'failed' } | { state: 'ok'; recipient_count: number; opted_out_count: number; sample: AudienceSample[] };

function AudienceBuilder({ templates, onClose, onDone }: { templates: readonly BroadcastTemplate[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [templateId, setTemplateId] = useState<string>();
  const [kinds, setKinds] = useState<readonly PartyKind[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [askKey] = useState(newKey);
  const createKey = useRef<{ body: string; key: string }>(undefined);
  const created = useRef<{ id: string; version: number }>(undefined);
  const once = useOnce();
  const reasonId = useId();
  const kindsKey = kinds.join(',');

  // Live count: every settled change asks again; the cleanup marks the older answer stale, so an out of order answer is ignored.
  useEffect(() => {
    created.current = undefined;
    if (kinds.length === 0) { setPreview({ state: 'idle' }); return; }
    let ignore = false;
    setPreview({ state: 'loading' });
    previewAudienceAction(templateId, { party_kinds: [...kinds], active_only: activeOnly })
      .then((r) => { if (!ignore) setPreview(r.ok ? { state: 'ok', recipient_count: r.recipient_count, opted_out_count: r.opted_out_count, sample: r.sample } : { state: 'failed' }); })
      .catch(() => { if (!ignore) setPreview({ state: 'failed' }); });
    return () => { ignore = true; };
  }, [templateId, kindsKey, activeOnly]); // eslint-disable-line react-hooks/exhaustive-deps -- kindsKey stands for kinds

  const toggle = (k: PartyKind, on: boolean) => setKinds((cur) => KINDS.filter((x) => (x === k ? on : cur.includes(x))));
  const all = kinds.length === KINDS.length;
  const block = !templateId || kinds.length === 0 ? 'engagement.msg.audience.choose'
    : preview.state === 'failed' ? 'engagement.msg.audience.failed'
      : preview.state !== 'ok' ? 'engagement.msg.audience.counting'
        : preview.recipient_count === 0 ? 'engagement.msg.audience.empty'
          : preview.recipient_count > LIMIT ? 'engagement.msg.error.recipient_limit' : undefined;

  const submit = (ask: boolean) => once(async () => {
    if (block || !templateId) return;
    setBusy(true);
    setText(undefined);
    try {
      const filter = { party_kinds: [...kinds], active_only: activeOnly };
      if (!created.current) {
        const body = JSON.stringify([templateId, filter]);
        if (createKey.current?.body !== body) createKey.current = { body, key: newKey() };
        const r = await createBroadcastAction(templateId, filter, createKey.current.key);
        if (!r.ok) return setText(msgRefusal(r).text);
        created.current = { id: r.id, version: r.version };
      }
      if (ask) {
        const r = await requestApprovalAction(created.current.id, created.current.version, askKey);
        if (!r.ok) return setText(msgRefusal(r).text);
      }
      onDone(t(ask ? 'engagement.msg.requested' : 'engagement.msg.drafted'));
    } finally {
      setBusy(false);
    }
  });

  const active = templates.filter((x) => x.is_active);
  return (
    <Dialog title={t('engagement.msg.new_broadcast')} isOpen onClose={onClose} size="md"
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>{t('engagement.msg.cancel')}</Button>
          <Gate variant="secondary" reasonId={block ? reasonId : undefined} isLoading={busy} onPress={() => void submit(false)}>{t('engagement.msg.save_draft')}</Gate>
          <Gate variant="primary" reasonId={block ? reasonId : undefined} isLoading={busy} onPress={() => void submit(true)}>{t('engagement.msg.request_approval')}</Gate>
        </>
      }>
      <div className="lims-stack">
        <Select label={t('engagement.msg.field.template')} name="template_id" isRequired options={active.map((x) => ({ value: x.id, label: x.name }))}
          {...(templateId ? { value: templateId } : {})} onChange={setTemplateId} />
        <fieldset className="lims-stack">
          <legend className="lims-label">{t('engagement.msg.audience')}</legend>
          <span className="lims-inline">
            {KINDS.map((k) => <Checkbox key={k} label={kindText(k)} name={k} isSelected={kinds.includes(k)} onChange={(on) => toggle(k, on)} />)}
            <Checkbox label={t('engagement.msg.select_all')} name="all" isSelected={all} onChange={() => setKinds(all ? [] : KINDS)} />
          </span>
          <Checkbox label={t('engagement.msg.active_only')} name="active_only" isSelected={activeOnly} onChange={setActiveOnly} />
        </fieldset>
        <div role="status" aria-live="polite" className="lims-stack">
          {preview.state === 'ok' && kinds.length ? (
            <>
              <p>{`${t('engagement.msg.audience.recipients')}: ${count(preview.recipient_count)}. ${t('engagement.msg.audience.opted_out')}: ${count(preview.opted_out_count)}.`}</p>
              {preview.recipient_count > LIMIT ? <p className="lims-error">{t('engagement.msg.error.recipient_limit')}</p> : null}
            </>
          ) : (
            <p>{t(preview.state === 'loading' ? 'engagement.msg.audience.counting' : preview.state === 'failed' ? 'engagement.msg.audience.failed' : 'engagement.msg.audience.choose')}</p>
          )}
        </div>
        {preview.state === 'ok' && preview.sample.length ? (
          <div className="lims-stack">
            <p className="lims-label">{t('engagement.msg.audience.sample')}</p>
            {/* T0D-UIGUARD-1-ENGAGEMENT (LD-436 R7): the masked sample is lines of text, not a raw list */}
            <div className="lims-stack">{preview.sample.map((s) => <span key={`${s.party_kind}-${s.party_id}`}>{`${kindText(s.party_kind)} ${s.channel_address}`}</span>)}</div>
          </div>
        ) : null}
        <p className="lims-description">{t('engagement.msg.never_sent')}</p>
        {block ? <ReasonLine id={reasonId}>{t(block)}</ReasonLine> : null}
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

function History({ broadcast, template, rows, failed }: { broadcast: Broadcast | undefined; template: BroadcastTemplate | undefined; rows: readonly BroadcastRecipient[]; failed?: string | undefined }) {
  const url = useUrl();
  const columns: ColumnDef<BroadcastRecipient>[] = [
    // a trailing space ends every cell so a row reads as words (as SalesTable does)
    { id: 'recipient', header: t('engagement.msg.col.recipient'), isRowHeader: true, cell: (r) => `${r.channel_address} ` },
    { id: 'type', header: t('engagement.msg.col.party_type'), cell: (r) => `${kindText(r.party_kind)} ` },
    { id: 'channel', header: t('engagement.msg.col.channel'), cell: () => `${template ? channelText(template.channel) : '—'} ` },
    {
      id: 'status', header: t('engagement.msg.col.status'),
      cell: (r) => <><Chip code={r.status} label={`${t(`engagement.msg.recipient.${r.status}`)}${r.skip_reason ? `, ${t(`engagement.msg.skip.${r.skip_reason}`)}` : ''}`} />{' '}</>,
    },
  ];
  return (
    // T0D-UIGUARD-1-ENGAGEMENT (LD-436 R7, LD-439): the history is a kit Card with a title row (title, recipient count caption), no raw heading
    <Card title={`${t('engagement.msg.history_title')}${template ? `: ${template.name}` : ''}`} {...(broadcast ? { caption: count(broadcast.recipient_count) } : {})}>
      <div className="lims-inline">
        <Button size="sm" variant="ghost" onPress={() => url.go({ broadcast: undefined }, true)}>{t('engagement.msg.history_close')}</Button>
      </div>
      <div className={!failed && rows.length === 0 ? 'msg-empty-state' : undefined} {...(failed ? { role: 'alert' } : {})}>
        <DataTable<BroadcastRecipient> caption={t('engagement.msg.history_title')} columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" cellTitle
          emptyState={{ title: t('engagement.msg.history_empty'), body: t('engagement.msg.history_empty_hint') }}
          {...(failed ? { error: { title: failed, onRetry: url.refresh } } : {})} />
      </div>
    </Card>
  );
}

export function Broadcasts({ rows: givenRows, templates: givenTemplates, me, permissions, status, failed, nextCursor, history }: {
  rows: readonly Broadcast[] | undefined; templates: readonly BroadcastTemplate[] | undefined; me: string | undefined; permissions: readonly string[];
  status: string | undefined; failed?: string | undefined; nextCursor?: string | undefined;
  history?: { id: string; rows: readonly BroadcastRecipient[]; failed?: string | undefined } | undefined;
}) {
  // LD-446: an undefined list renders the empty state, not "reading 'map' of undefined"
  const rows = givenRows ?? [];
  const templates = givenTemplates ?? [];
  const toast = useToast();
  const url = useUrl();
  const once = useOnce();
  const manageId = useId();
  const approveId = useId();
  const secondId = useId();
  const canManage = hasPerm(permissions, MANAGE);
  const canApprove = hasPerm(permissions, APPROVE);
  const [building, setBuilding] = useState(false);
  const [approving, setApproving] = useState<Broadcast | null>(null);
  const [cancelling, setCancelling] = useState<Broadcast | null>(null);
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const byId = new Map(templates.map((x) => [x.id, x]));
  const name = (id: string) => byId.get(id)?.name ?? t('engagement.msg.unknown_template');
  const who = (id: string | undefined) => (!id ? '—' : id === me ? t('engagement.msg.you') : t('engagement.msg.other_user'));
  const done = (msg: string) => { setBuilding(false); setApproving(null); setCancelling(null); setNotice(undefined); toast.show({ tone: 'success', title: msg }); url.refresh(); };
  const manage = canManage ? undefined : manageId;
  const approveReason = (b: Broadcast) => (!canApprove ? approveId : b.requested_by === me ? secondId : undefined);
  const mine = rows.some((b) => b.status === 'pending_approval' && b.requested_by === me);

  const ask = (b: Broadcast) => once(async () => {
    setBusyId(b.id);
    setNotice(undefined);
    try {
      const r = await requestApprovalAction(b.id, b.version, newKey());
      if (r.ok) return done(t('engagement.msg.requested'));
      setNotice(msgRefusal(r).text);
      if (r.code === 'common.version_conflict') url.refresh();
    } finally {
      setBusyId(undefined);
    }
  });

  const columns: Col<Broadcast>[] = [
    { id: 'template', header: t('engagement.msg.col.template'), isRowHeader: true, cell: (b) => name(b.template_id) },
    { id: 'audience', header: t('engagement.msg.col.audience'), cell: (b) => (b.audience_filter?.party_kinds ?? []).map(kindText).join(', ') },
    { id: 'recipients', header: t('engagement.msg.col.recipients'), align: 'end', cell: (b) => count(b.recipient_count) },
    { id: 'status', header: t('engagement.msg.col.status'), cell: (b) => <Chip code={b.status} label={t(`engagement.msg.status.${b.status}`)} /> },
    { id: 'requested_by', header: t('engagement.msg.col.requested_by'), cell: (b) => who(b.requested_by) },
    { id: 'approved_by', header: t('engagement.msg.col.approved_by'), cell: (b) => who(b.approved_by) },
    {
      id: 'actions', header: t('engagement.msg.col.actions'),
      cell: (b) => (
        <span className="lims-inline">
          {b.status === 'draft' ? <Gate size="sm" variant="ghost" reasonId={manage} isLoading={busyId === b.id} onPress={() => void ask(b)}>{t('engagement.msg.request_approval')}</Gate> : null}
          {b.status === 'pending_approval' ? <Gate size="sm" variant="ghost" reasonId={approveReason(b)} onPress={() => setApproving(b)}>{t('engagement.msg.approve')}</Gate> : null}
          {b.status === 'draft' || b.status === 'pending_approval' || b.status === 'approved'
            ? <Gate size="sm" variant="ghost" reasonId={manage} onPress={() => setCancelling(b)}>{t('engagement.msg.cancel_broadcast')}</Gate> : null}
          <Button size="sm" variant="ghost" onPress={() => url.go({ broadcast: b.id }, true)}>{t('engagement.msg.history')}</Button>
        </span>
      ),
    },
  ];

  const shown = history ? rows.find((b) => b.id === history.id) : undefined;
  return (
    <section className="lims-stack">
      <PageHeader title={t('engagement.nav.msg_broadcasts')} helpKey="engagement.msg_broadcasts"
        actions={<Gate variant="primary" reasonId={manage} onPress={() => setBuilding(true)}>{t('engagement.msg.new_broadcast')}</Gate>} />
      {manage ? <ReasonLine id={manageId}>{t('engagement.msg.reason.manage')}</ReasonLine> : null}
      {!canApprove && rows.some((b) => b.status === 'pending_approval') ? <ReasonLine id={approveId}>{t('engagement.msg.reason.approve')}</ReasonLine> : null}
      {canApprove && mine ? <ReasonLine id={secondId}>{t('engagement.msg.reason.second_person')}</ReasonLine> : null}
      <FilterBar
        filters={[{ id: 'status', label: t('engagement.msg.filter.status'), kind: 'select', options: STATUSES.map((s) => ({ value: s, label: t(`engagement.msg.status.${s}`) })) }]}
        value={status ? { status } : {}}
        onChange={(v) => { const s = typeof v['status'] === 'string' ? v['status'] : undefined; if (s !== status) url.go({ status: s, cursor: undefined, broadcast: undefined }); }}
        onReset={() => url.go({ status: undefined, cursor: undefined, broadcast: undefined })}
      />
      <Alert text={notice} />
      <SalesTable caption={t('engagement.nav.msg_broadcasts')} columns={columns} rows={rows} getRowId={(b) => b.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('engagement.msg.broadcasts_empty'), body: t('engagement.msg.broadcasts_empty_hint') }} />
      {history ? <History broadcast={shown} template={shown ? byId.get(shown.template_id) : undefined} rows={history.rows ?? []} failed={history.failed} /> : null}
      {building ? <AudienceBuilder templates={templates} onClose={() => setBuilding(false)} onDone={done} /> : null}
      {approving ? (
        <Confirm title={t('engagement.msg.approve_title')} confirm={t('engagement.msg.approve')} dismiss={t('engagement.msg.cancel')}
          act={(key) => approveBroadcastAction(approving.id, approving.version, key)} onClose={() => setApproving(null)} onDone={() => done(t('engagement.msg.approved_done'))}>
          <p>{`${t('engagement.msg.col.template')}: ${name(approving.template_id)}. `}</p>
          <p>{`${t('engagement.msg.col.recipients')}: ${count(approving.recipient_count)}. `}</p>
          <p className="lims-description">{t('engagement.msg.approve_body')}</p>
        </Confirm>
      ) : null}
      {cancelling ? (
        <Confirm title={`${t('engagement.msg.cancel_broadcast')}: ${name(cancelling.template_id)}`} confirm={t('engagement.msg.yes_cancel')} dismiss={t('engagement.msg.keep')} danger
          act={(key) => cancelBroadcastAction(cancelling.id, cancelling.version, key)} onClose={() => setCancelling(null)} onDone={() => done(t('engagement.msg.cancelled_done'))}>
          <p className="lims-description">{t('engagement.msg.cancel_body')}</p>
        </Confirm>
      ) : null}
    </section>
  );
}

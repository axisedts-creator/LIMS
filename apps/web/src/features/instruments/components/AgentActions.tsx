'use client';
// SCR-02 manage actions (04-UI-UX §3): Request command ▾ (E17), Revoke (E15), Retire (E16), Edit (E13).
// Revoke/Retire/Edit send If-Match with the agent version; E17 sends one Idempotency-Key per user request.
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Menu } from '@lims/ui/components/Menu';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextField } from '@lims/ui/components/TextField';
import { Tooltip } from '@lims/ui/components/Tooltip';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { requestAgentCommandAction, retireAgentAction, revokeAgentAction, updateAgentAction } from '../server/actions';
import { COMMAND_KINDS, REVOKE_REASONS, type ActionResult, type Agent, type AgentCommandKind, type InstrumentSummary, type UpdateChannel } from '../server/types';

const COMMAND_ITEMS: readonly { id: AgentCommandKind; label: string }[] = [
  { id: 'upload_logs', label: 'Upload logs' },
  { id: 'refresh_config', label: 'Refresh configuration' },
  { id: 'restart_service', label: 'Restart service' },
  { id: 'reupload_since', label: 'Re-upload since…' },
];
const RETIRE_BLOCKED = 'Retire every instrument on this agent first.'; // [CONV] tooltip text
const REUPLOAD_WINDOW_MS = 72 * 3_600_000;
const reason = { codedSet: 'instruments.g_cs_revoke_reasons', options: REVOKE_REASONS, freeText: { maxLength: 300, isRequired: false } };

type Open = 'none' | 'revoke' | 'retire' | 'edit' | 'reupload';

export function AgentActions({ agent, instruments, onCommandRequested }: { agent: Agent; instruments: readonly InstrumentSummary[]; onCommandRequested: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Open>('none');
  const close = () => setOpen('none');
  const activeInstruments = instruments.some((i) => i.state !== 'retired');
  const retireHintId = useId();

  const after = (r: ActionResult<unknown>, success: string, failure: string) => {
    if (r.ok) {
      close();
      toast.show({ tone: 'success', title: success });
      router.refresh();
    } else {
      toast.show({ tone: 'danger', title: failure, description: r.code });
    }
    return r.ok;
  };

  const command = async (kind: AgentCommandKind, since?: string) => {
    const r = await requestAgentCommandAction(agent.id, { kind, ...(since ? { since } : {}) }, crypto.randomUUID());
    if (after(r, 'Command queued. The agent picks it up with its next heartbeat.', 'Could not queue the command')) onCommandRequested(); // [CONV] texts
  };

  return (
    <>
      <Menu
        trigger={<Button>Request command ▾</Button>}
        items={COMMAND_ITEMS}
        onAction={(id) => {
          if (!(COMMAND_KINDS as readonly string[]).includes(id)) return;
          if (id === 'reupload_since') setOpen('reupload');
          else void command(id as AgentCommandKind);
        }}
      />
      <Button variant="danger" onPress={() => setOpen('revoke')}>Revoke</Button>
      {/* 04-UI-UX: Retire disabled with tooltip while instruments are not retired. [CONV] tooltip text */}
      {activeInstruments ? (
        <>
          {/* Disabled buttons get no hover/focus, so the tooltip text is also linked via aria-describedby (Button has no such prop). */}
          <Tooltip content={RETIRE_BLOCKED}>
            <Button variant="danger" isDisabled ref={(el) => el?.setAttribute('aria-describedby', retireHintId)}>Retire</Button>
          </Tooltip>
          <VisuallyHidden id={retireHintId}>{RETIRE_BLOCKED}</VisuallyHidden>
        </>
      ) : (
        <Button variant="danger" onPress={() => setOpen('retire')}>Retire</Button>
      )}
      <Button onPress={() => setOpen('edit')}>Edit</Button>

      <ConfirmDialog
        title="Revoke agent"
        tone="danger"
        isOpen={open === 'revoke'}
        confirmLabel="Revoke"
        onCancel={close}
        requireReason={reason}
        body={<p>The PC stops uploading immediately. Messages already on the PC stay there until it is re-enrolled.</p>}
        onConfirm={async ({ reasonCode, reasonText }) => {
          if (!reasonCode) return;
          after(await revokeAgentAction(agent.id, agent.version, { reason_code: reasonCode, ...(reasonText ? { reason_text: reasonText } : {}) }), 'Agent revoked.', 'Could not revoke the agent'); // [CONV]
        }}
      />
      <ConfirmDialog
        title="Retire agent"
        tone="danger"
        isOpen={open === 'retire'}
        confirmLabel="Retire"
        onCancel={close}
        requireReason={reason}
        body={<p>A retired agent cannot enrol or upload again.</p>} // [CONV]
        onConfirm={async ({ reasonCode, reasonText }) => {
          if (!reasonCode) return;
          after(await retireAgentAction(agent.id, agent.version, { reason_code: reasonCode, ...(reasonText ? { reason_text: reasonText } : {}) }), 'Agent retired.', 'Could not retire the agent'); // [CONV]
        }}
      />
      {open === 'edit' ? <EditAgentDialog agent={agent} onClose={close} onDone={(r) => after(r, 'Agent saved.', 'Could not save the agent')} /> : null}
      {open === 'reupload' ? <ReuploadDialog onClose={close} onSubmit={(since) => command('reupload_since', since)} /> : null}
    </>
  );
}

function EditAgentDialog({ agent, onClose, onDone }: { agent: Agent; onClose: () => void; onDone: (r: ActionResult<unknown>) => void }) {
  const [name, setName] = useState(agent.display_name);
  const [channel, setChannel] = useState<UpdateChannel>(agent.update_channel);
  const [threshold, setThreshold] = useState<number | undefined>(agent.backlog_threshold);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || name.length < 1) return;
    setBusy(true);
    try {
      onDone(await updateAgentAction(agent.id, agent.version, { display_name: name, update_channel: channel, ...(threshold !== undefined ? { backlog_threshold: threshold } : {}) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Edit agent" isOpen onClose={onClose} size="md">
      <Form onSubmit={submit}>
        <TextField label="Name" name="display_name" maxLength={80} isRequired value={name} onChange={setName} />
        <RadioGroup<UpdateChannel> label="Update channel" name="update_channel" value={channel} onChange={setChannel} orientation="horizontal" options={[{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }]} />
        <IntegerField label="Backlog threshold" name="backlog_threshold" min={10} max={100000} {...(threshold !== undefined ? { value: threshold } : {})} onChange={setThreshold} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy}>Save</Button>
      </Form>
    </Dialog>
  );
}

function ReuploadDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (since: string) => Promise<void> }) {
  const [since, setSince] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    const t = since ? Date.parse(since) : NaN;
    const now = Date.now();
    if (!(t <= now && t >= now - REUPLOAD_WINDOW_MS)) {
      setError('Choose a time within the last 72 hours.'); // [CONV]
      return;
    }
    setBusy(true);
    try {
      await onSubmit(new Date(t).toISOString());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Re-upload since" isOpen onClose={onClose} size="sm">
      <Form onSubmit={submit}>
        <DateTimePicker label="Since" name="since" isRequired {...(since ? { value: since as never } : {})} {...(error ? { error } : {})} onChange={(v) => { setSince(v); setError(undefined); }} />
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy}>Request re-upload</Button>
      </Form>
    </Dialog>
  );
}

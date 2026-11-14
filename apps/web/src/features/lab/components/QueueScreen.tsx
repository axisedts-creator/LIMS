'use client';
// Shared body of /lab/verification and /lab/approval (04-UI-UX §3.8, §3.6 "Approve"). Selection → bulk call (≤200 per request, one Idempotency-Key per request,
// 02-CONVENTIONS §4.5) → per-id outcome dialog. Server state decides: closing the dialog re-fetches the list (router.refresh), rows are never edited locally.
// Flag acknowledgement mirrors result.service `needed()`: delta fail / critical / unit mismatch / instrument flags each need their own tick before a verify is sent (AC-12.3).
// 403 auth.mfa_required (AC-16.3): warning banner → "Verify now" → onStepUp → the SAME request re-sent with the SAME key. The API still enforces permission + aal2 (S-01); the UI only hides.
import { useRef, useState, type KeyboardEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FlagBadge, type ResultFlag } from '@lims/ui/components/FlagBadge';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { bulkApproveAction, bulkVerifyAction } from '../server/actions';
import type { AckFlag, QueueItem, ResultBulkRow, VerifyItem } from '../server/types';
import { FAILED, call, newKey } from './shared';

export type QueueMode = 'verify' | 'approve';
export interface QueueProps { items: QueueItem[]; permissions: readonly string[]; onStepUp?: () => Promise<void> | void }

const MAX = 200; // OpenAPI maxItems
const AGE_UNKNOWN = 'Age unknown — reference range and critical check not applied'; // 08 A17.1
const MFA = 'Approval needs a second check. Verify your identity, then the approval is sent again.';
const FLAG_LABEL: Record<AckFlag, string> = { delta: 'delta', critical: 'critical', unit_mismatch: 'unit mismatch', instrument_flag: 'instrument flag' };
const COPY = {
  verify: { title: 'Verification', empty: 'Nothing waiting for verification.', verb: 'Verify', perm: 'lab.result.verify', done: 'Verification outcome' },
  approve: { title: 'Approval', empty: 'Nothing waiting for approval.', verb: 'Approve', perm: 'lab.result.approve', done: 'Approval outcome' },
} as const;
/** Per-id reasons (contracts/errors.yaml titles; copy for the two approve codes is verbatim from 04-UI-UX §3.6). Raw codes are never shown. */
const REASON: Record<string, string> = {
  'lab.result_invalid_transition': 'This result is no longer in the right state.',
  'lab.result_on_hold': 'This result is on hold.',
  'lab.flag_ack_required': 'Acknowledge the flags before verifying.',
  'common.version_conflict': 'This result changed since the list was loaded. Reload and try again.',
  'common.not_found': 'Result not found.',
  'lab.self_approval_forbidden': 'You verified this result. Another pathologist must approve it.',
  'lab.critical_ack_required': 'Record the critical-value notification before approving.',
};
const reason = (code?: string) => (code && REASON[code]) || 'Could not update this result.';

/** Flags this result needs acknowledged before verify (mirrors result.service `needed()`). */
export function neededFlags(r: QueueItem['result']): AckFlag[] {
  const f: AckFlag[] = [];
  if (r.delta?.status === 'fail') f.push('delta');
  if (r.critical.is_critical) f.push('critical');
  if (r.unit_mismatch) f.push('unit_mismatch');
  if (r.instrument_flags?.length) f.push('instrument_flag');
  return f;
}

type Job = { sig: string; keys: string[]; chunks: VerifyItem[][]; next: number; rows: ResultBulkRow[] };

export function QueueScreen({ mode, items, permissions, onStepUp }: QueueProps & { mode: QueueMode }) {
  const c = COPY[mode];
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const canAct = permissions.includes(c.perm);
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [acks, setAcks] = useState<Record<string, AckFlag[]>>({});
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<'mfa' | 'error' | null>(null);
  const [outcome, setOutcome] = useState<ResultBulkRow[] | null>(null);
  const busyRef = useRef(false);
  const job = useRef<Job | null>(null); // survives the step-up pause so the retry reuses keys + body

  const picked = items.filter((i) => sel.has(i.result.id));
  const blocked = mode === 'verify' && picked.some((i) => neededFlags(i.result).some((f) => !acks[i.result.id]?.includes(f)));
  const toggle = (id: string, on: boolean) => setSel((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  const toggleAck = (id: string, f: AckFlag, on: boolean) => setAcks((p) => ({ ...p, [id]: on ? [...(p[id] ?? []), f] : (p[id] ?? []).filter((x) => x !== f) }));

  function onRowKey(e: KeyboardEvent<HTMLTableRowElement>, id: string) {
    if (e.key !== 'ArrowDown' || !e.shiftKey) return;
    const next = e.currentTarget.nextElementSibling?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!next) return;
    e.preventDefault();
    const nextId = items[items.findIndex((i) => i.result.id === id) + 1]?.result.id;
    setSel((p) => new Set(p).add(id).add(nextId ?? id));
    next.focus();
  }

  async function run(j: Job) {
    for (let i = j.next; i < j.chunks.length; i++) {
      const r = await call((mode === 'verify' ? bulkVerifyAction : bulkApproveAction)(j.chunks[i]!, j.keys[i]!));
      if (!r.ok) {
        if (r.status === 403 && r.code === 'auth.mfa_required') { j.next = i; setBanner('mfa'); return; }
        job.current = null;
        if (j.rows.length === 0) { setBanner('error'); return; }
        // earlier chunks already changed server state: report them, and the unsent rest as not done
        j.rows.push(...j.chunks.slice(i).flat().map((x) => ({ id: x.id, outcome: 'error' as const, code: 'common.internal' })));
        break;
      }
      j.rows.push(...r.data);
    }
    job.current = null;
    setBanner(null);
    setSel(new Set());
    setAcks({});
    setOutcome(j.rows);
  }

  async function send() {
    if (busyRef.current || picked.length === 0 || blocked) return;
    const body: VerifyItem[] = picked.map((i) => ({
      id: i.result.id,
      version: i.result.version,
      ...(mode === 'verify' && neededFlags(i.result).length ? { acknowledged_flags: [...neededFlags(i.result)].sort() } : {}),
    }));
    const sig = JSON.stringify(body);
    if (job.current?.sig !== sig) {
      const chunks = Array.from({ length: Math.ceil(body.length / MAX) }, (_, k) => body.slice(k * MAX, (k + 1) * MAX));
      job.current = { sig, keys: chunks.map(() => newKey()), chunks, next: 0, rows: [] };
    }
    busyRef.current = true;
    setBusy(true);
    setBanner(null);
    try { await run(job.current); } finally { busyRef.current = false; setBusy(false); }
  }

  async function verifyNow() {
    if (busyRef.current || !job.current) return;
    busyRef.current = true;
    try {
      // ponytail: no C2 step-up route known; default reloads so the session guard can redirect (same as analytics ExportDialog)
      await (onStepUp ?? (() => { window.location.reload(); return new Promise<void>(() => undefined); }))();
    } catch {
      busyRef.current = false; // cancelled / failed: banner and selection stay, nothing re-sent
      return;
    }
    busyRef.current = false;
    if (job.current) { busyRef.current = true; setBusy(true); try { await run(job.current); } finally { busyRef.current = false; setBusy(false); } }
  }

  const setFlagged = (on: boolean) => {
    const q = new URLSearchParams(params.toString());
    if (on) q.set('flagged_only', 'true'); else q.delete('flagged_only');
    router.push(q.size ? `${pathname}?${q}` : pathname);
  };
  const close = () => { setOutcome(null); router.refresh(); };
  const failed = (outcome ?? []).filter((o) => o.outcome === 'error');
  const byId = new Map(items.map((i) => [i.result.id, i]));

  return (
    <section aria-label={c.title}>
      <PageHeader title={c.title} helpKey={`lab.${mode}`} />
      <Checkbox label="Flagged only" isSelected={params.get('flagged_only') === 'true'} onChange={setFlagged} />
      {banner === 'mfa' ? (
        <div role="alert"><Banner tone="warning" title={MFA} action={{ label: 'Verify now', onPress: () => void verifyNow() }} /></div>
      ) : banner === 'error' ? (
        <div role="alert"><Banner tone="danger" title={FAILED} /></div>
      ) : null}
      {items.length === 0 ? (
        <EmptyState title={c.empty} />
      ) : (
        <>
          {canAct ? (
            <Button variant="primary" isLoading={busy} isDisabled={picked.length === 0 || blocked} onPress={() => void send()}>
              {`${c.verb} ${picked.length}`}
            </Button>
          ) : null}
          <table>
            <caption className="lims-visually-hidden">{c.title} queue</caption>
            <thead>
              <tr>
                <th scope="col">{canAct ? <Checkbox label="Select all" isSelected={picked.length === items.length} onChange={(on) => setSel(on ? new Set(items.map((i) => i.result.id)) : new Set())} /> : <span className="lims-visually-hidden">Select</span>}</th>
                <th scope="col">Priority</th>
                <th scope="col">Reg no</th>
                <th scope="col">Patient</th>
                <th scope="col">Analyte</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const r = i.result;
                const need = mode === 'verify' ? neededFlags(r) : [];
                return (
                  <tr key={r.id} onKeyDown={canAct ? (e) => onRowKey(e, r.id) : undefined}>
                    <td>{canAct ? <Checkbox label={`Select ${i.registration_no}`} isSelected={sel.has(r.id)} onChange={(on) => toggle(r.id, on)} /> : null}</td>
                    <td>{i.priority}</td>
                    <td>{i.registration_no}</td>
                    <td><span>{i.patient_display.full_name}</span> <span>{i.patient_display.age_sex}</span></td>
                    <td>{r.analyte_code}</td>
                    <td>
                      {r.flag ? <FlagBadge flag={r.flag as ResultFlag} /> : null}
                      {r.range_unavailable_age_unknown ? <div>{AGE_UNKNOWN}</div> : null}
                      {canAct ? need.map((f) => (
                        <Checkbox key={f} label={`Acknowledge ${FLAG_LABEL[f]}`} isSelected={acks[r.id]?.includes(f) ?? false} onChange={(on) => toggleAck(r.id, f, on)} />
                      )) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <Dialog title={c.done} isOpen={outcome !== null} onClose={close}>
        <p>{`${(outcome?.length ?? 0) - failed.length} done, ${failed.length} not done`}</p>
        {failed.length ? (
          <ul>
            {failed.map((o) => {
              const i = byId.get(o.id);
              const ev = o.code === 'lab.critical_ack_required' ? i?.result.critical.critical_event_id : undefined;
              return (
                <li key={o.id}>
                  {`${i ? `${i.registration_no} · ${i.patient_display.full_name} · ${i.result.analyte_code}` : 'Result'}: `}<span>{reason(o.code)}</span>
                  {ev ? <> <a href={`/lab/critical-values/${encodeURIComponent(ev)}`}>Open critical value</a></> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Dialog>
    </section>
  );
}

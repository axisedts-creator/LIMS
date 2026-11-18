'use client';
// Shared body of /lab/verification and /lab/approval (04-UI-UX §3.8, §3.6 "Approve"). Selection → bulk call (≤200 per request, one Idempotency-Key per request,
// 02-CONVENTIONS §4.5) → per-id outcome dialog. Server state decides: closing the dialog re-fetches the list (router.refresh), rows are never edited locally.
// Flag acknowledgement mirrors result.service `needed()`: delta fail / critical / unit mismatch / instrument flags each need their own tick before a verify is sent (AC-12.3).
// 403 auth.mfa_required (AC-16.3): warning banner → "Verify now" → onStepUp → the SAME request re-sent with the SAME key. The API still enforces permission + aal2 (S-01); the UI only hides.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FlagBadge, type ResultFlag } from '@lims/ui/components/FlagBadge';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { bulkApproveAction, bulkVerifyAction } from '../server/actions';
import type { ResultSignoff } from '../server/config.types';
import { getResultSignoffsAction } from '../server/config.actions';
import type { AckFlag, QueueItem, ResultBulkRow, VerifyItem } from '../server/types';
import { FAILED, call, newKey, utc } from './shared';

export type QueueMode = 'verify' | 'approve';
/** currentUserId (T0D-VERLEVEL-1): the signed in person's user id = signer_user_id of their own sign-offs; without it nothing is dimmed (the API still refuses). */
export interface QueueProps { items: QueueItem[]; permissions: readonly string[]; onStepUp?: () => Promise<void> | void; currentUserId?: string | undefined }

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
  // T0D-VERLEVEL-1 (LD-316, LD-318 follow-up 4): the three sign-off refusals
  'lab.verifier_not_distinct': 'You already signed this result. A different person must sign it next.',
  'lab.enterer_cannot_verify': 'You entered this result. Someone else must sign it off.',
  'lab.pathologist_required': 'The final sign-off of this result must come from a pathologist.',
};
/** next_step -> what the row waits for (lab.yaml ResultDto.next_step). */
const NEXT: Record<string, string> = { verify: 'Needs verifier', approve: 'Needs pathologist', none: 'Ready' };
const MINE = 'You already signed this result';
type Chain = ResultSignoff[] | 'error';
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

export function QueueScreen({ mode, items, permissions, onStepUp, currentUserId }: QueueProps & { mode: QueueMode }) {
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
  const [chains, setChains] = useState<Record<string, Chain>>({});
  const [openChip, setOpenChip] = useState<string | null>(null);
  const asked = useRef(new Set<string>()); // one sign-off read per row
  const uid = useId();

  // T0D-VERLEVEL-1: rows with sign-offs load their chain once; rows with none never ask
  useEffect(() => {
    for (const i of items) {
      const id = i.result.id;
      if (!((i.result.signoff_count ?? 0) > 0) || asked.current.has(id)) continue;
      asked.current.add(id);
      void call(getResultSignoffsAction(id)).then((r) => setChains((p) => ({ ...p, [id]: r.ok ? r.data : 'error' })));
    }
  }, [items]);
  /** Signed by me on the current version: dimmed, not selectable, never sent. */
  const mine = (r: QueueItem['result']) => {
    const ch = chains[r.id];
    return !!currentUserId && Array.isArray(ch) && ch.some((s) => s.signer_user_id === currentUserId && (r.current_version_no === undefined || s.result_version === r.current_version_no));
  };
  const selectable = items.filter((i) => !mine(i.result));
  const picked = selectable.filter((i) => sel.has(i.result.id));
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
      {/* T0D-EMPTYTBL-1 (LD-310): headers always drawn; the empty message is a body row. */}
      <>
          {canAct && items.length > 0 ? (
            <Button variant="primary" isLoading={busy} isDisabled={picked.length === 0 || blocked} onPress={() => void send()}>
              {`${c.verb} ${picked.length}`}
            </Button>
          ) : null}
          <table>
            <caption className="lims-visually-hidden">{c.title} queue</caption>
            <thead>
              <tr>
                <th scope="col">{canAct && items.length > 0 ? <Checkbox label="Select all" isSelected={picked.length > 0 && picked.length === selectable.length} onChange={(on) => setSel(on ? new Set(selectable.map((i) => i.result.id)) : new Set())} /> : <span className="lims-visually-hidden">Select</span>}</th>
                <th scope="col">Priority</th>
                <th scope="col">Reg no</th>
                <th scope="col">Patient</th>
                <th scope="col">Analyte</th>
                <th scope="col">Flags</th>
                <th scope="col">Sign-off</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? <EmptyRow colSpan={7}><EmptyState title={c.empty} /></EmptyRow> : null}
              {items.map((i) => {
                const r = i.result;
                const need = mode === 'verify' ? neededFlags(r) : [];
                const dim = mine(r);
                return (
                  <tr key={r.id} onKeyDown={canAct ? (e) => onRowKey(e, r.id) : undefined} {...(dim ? { 'aria-disabled': true, className: 'lims-row-dim', style: { opacity: 0.55 } } : {})}>
                    <td>{canAct ? <Checkbox label={`Select ${i.registration_no}`} isSelected={!dim && sel.has(r.id)} isDisabled={dim} onChange={(on) => toggle(r.id, on)} /> : null}</td>
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
                    <td>
                      {r.signoff_count !== undefined && r.signoff_required !== undefined ? (
                        <SignoffCell listId={`${uid}-${r.id}`} count={r.signoff_count} required={r.signoff_required} next={r.next_step} chain={chains[r.id]}
                          open={openChip === r.id} onToggle={() => setOpenChip((o) => (o === r.id ? null : r.id))} />
                      ) : null}
                      {dim ? <div>{MINE}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {items.length === 0 ? <PlaceholderRows colSpan={7} /> : null}
          </table>
      </>
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

/** T0D-VERLEVEL-1: "Signed n of m" chip (a button, so the keyboard reaches it), the next step label and, when open, who signed (plain text, never markup). */
function SignoffCell({ listId, count, required, next, chain, open, onToggle }: {
  listId: string; count: number; required: number; next: string | undefined; chain: Chain | undefined; open: boolean; onToggle: () => void;
}) {
  const rows = Array.isArray(chain) ? chain : [];
  return (
    <div>
      <button type="button" className="lims-chip" aria-expanded={open} {...(open ? { 'aria-controls': listId } : {})} onClick={onToggle}>{`Signed ${count} of ${required}`}</button>
      {next && NEXT[next] ? <> <span>{NEXT[next]}</span></> : null}
      {open ? (
        chain === 'error' ? <p id={listId}>Could not load who signed.</p>
          : count === 0 || (chain && rows.length === 0) ? <p id={listId}>No sign-offs yet.</p>
          : !chain ? <p id={listId} role="status">Loading…</p>
          : (
            <ul id={listId} aria-label="Signed by">
              {rows.map((s) => (
                <li key={`${s.result_version}-${s.seq}`}>
                  <span>{s.signer_display_name}</span>{[s.signer_title, s.signer_role_code.replace(/_/g, ' '), utc(s.signed_at)].filter(Boolean).map((x) => ` · ${x}`).join('')}
                </li>
              ))}
            </ul>
          )
      ) : null}
    </div>
  );
}

'use client';
// Shared body of /lab/verification and /lab/approval (04-UI-UX §3.8, §3.6 "Approve"). Selection → bulk call (≤200 per request, one Idempotency-Key per request,
// 02-CONVENTIONS §4.5) → per-id outcome dialog. Server state decides: closing the dialog re-fetches the list (router.refresh), rows are never edited locally.
// Flag acknowledgement mirrors result.service `needed()`: delta fail / critical / unit mismatch / instrument flags each need their own tick before a verify is sent (AC-12.3).
// 403 auth.mfa_required (AC-16.3): warning banner → "Verify now" → onStepUp → the SAME request re-sent with the SAME key. The API still enforces permission + aal2 (S-01); the UI only disables.
// T0D-UICONSOLE-2 (LD-353 template 2 CONSOLE, rules 5, 6, 8; LD-364): PageHeader (menu label), ONE FilterBar (Flagged only), StatTiles (Pending, Flagged, Oldest wait) above ONE SplitConsole:
// queue left = one item per registration; detail right = patient strip, results table, audit line; sticky bar = Select all unflagged (S), Verify|Approve (V|A), Return for repeat (R), Hold (H).
// Display only: same operations (bulkVerify / bulkApprove / returnResult), same permissions, same VERLEVEL-1 rules. A control the user may not use is disabled with its reason, never hidden.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { FlagBadge, type ResultFlag } from '@lims/ui/components/FlagBadge';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SplitConsole } from '@lims/ui/components/SplitConsole';
import { StatTile, StatTileRow } from '@lims/ui/components/StatTile';
import { t } from '@/core/i18n/messages';
import { isOnline, useOfflineFlows, useOfflineSnapshot } from '@/core/offline/ui/OfflineProvider';
import { PendingSyncBadge } from '@/core/offline/ui/OfflineParts';
import { bulkApproveAction, bulkVerifyAction, returnResultAction } from '../server/actions';
import type { ResultSignoff } from '../server/config.types';
import { getResultSignoffsAction, listCodedSetAction } from '../server/config.actions';
import type { AckFlag, CodedOption, GridResult, QueueItem, QueueResult, ResultBulkRow, VerifyItem } from '../server/types';
import { FAILED, call, newKey, utc } from './shared';
import { domAttrs, hhmm, useNow } from './consoleParts';
import { ReturnDialog } from './grid/ResultDialogs';
import { actionError } from './grid/resultModel';

export type QueueMode = 'verify' | 'approve';
/** currentUserId (T0D-VERLEVEL-1): the signed in person's user id = signer_user_id of their own sign-offs; without it nothing is dimmed (the API still refuses).
 *  pending (T0D-UICONSOLE-2, LD-353 rule 6): the queue read answered 501 operation_pending; the console keeps its title, filter and header row and says Not available yet. */
export interface QueueProps { items: QueueItem[]; permissions: readonly string[]; onStepUp?: () => Promise<void> | void; currentUserId?: string | undefined; pending?: boolean }

/** ResultDto fields the console detail reads (lab.yaml ResultDto); typed here because features/lab/server is pinned by rs-c5.static (LD-140). */
type Res = QueueResult & Partial<Pick<GridResult, 'value_numeric' | 'value_text' | 'unit_code' | 'reference_range_snapshot' | 'comment_text'>> & {
  delta?: GridResult['delta']; verified_at?: string;
};
type Reg = { no: string; items: (QueueItem & { result: Res })[] };

const MAX = 200; // OpenAPI maxItems
const DASH = '—';
const AGE_UNKNOWN = 'Age unknown — reference range and critical check not applied'; // 08 A17.1
const MFA = 'Approval needs a second check. Verify your identity, then the approval is sent again.';
const NOT_YET = 'This part of the system is being built. It appears here once it is switched on.';
const FLAG_LABEL: Record<AckFlag, string> = { delta: 'delta', critical: 'critical', unit_mismatch: 'unit mismatch', instrument_flag: 'instrument flag' };
const COPY = {
  verify: { menu: 'lab.nav.verification', empty: 'Nothing waiting for verification.', verb: 'Verify', key: 'v', perm: 'lab.result.verify', done: 'Verification outcome', denied: 'You do not have permission to verify results.' },
  approve: { menu: 'lab.nav.approval', empty: 'Nothing waiting for approval.', verb: 'Approve', key: 'a', perm: 'lab.result.approve', done: 'Approval outcome', denied: 'You do not have permission to approve results.' },
} as const;
/** Per-id reasons (contracts/errors.yaml titles; copy for the two approve codes is verbatim from 04-UI-UX §3.6). Raw codes are never shown. */
const REASON: Record<string, string> = {
  'lab.result_invalid_transition': t('lab.reason.lab.result_invalid_transition'),
  'lab.result_on_hold': 'This result is on hold.',
  'lab.flag_ack_required': t('lab.reason.lab.flag_ack_required'),
  'common.version_conflict': 'This result changed since the list was loaded. Reload and try again.',
  'common.not_found': 'Result not found.',
  'lab.self_approval_forbidden': 'You verified this result. Another pathologist must approve it.',
  'lab.critical_ack_required': 'Record the critical-value notification before approving.',
  // T0D-VERLEVEL-1 (LD-316, LD-318 follow-up 4): the three sign-off refusals; T0D-OFFLINE-4 (LD-322): texts in the catalogue, shared with the offline checks
  'lab.verifier_not_distinct': t('lab.reason.lab.verifier_not_distinct'),
  'lab.enterer_cannot_verify': t('lab.reason.lab.enterer_cannot_verify'),
  'lab.pathologist_required': t('lab.reason.lab.pathologist_required'),
  'sync.offline_not_allowed': t('offline.refusal.sync.offline_not_allowed'),
};
/** next_step -> what the row waits for (lab.yaml ResultDto.next_step). */
const NEXT: Record<string, string> = { verify: 'Needs verifier', approve: 'Needs pathologist', none: 'Ready' };
const MINE = 'You already signed this result';
type Chain = ResultSignoff[] | 'error';
const reason = (code?: string) => (code && REASON[code]) || 'Could not update this result.';
const isTyping = (el: EventTarget | null) => { const e = el as HTMLElement | null; return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)); };

/** Flags this result needs acknowledged before verify (mirrors result.service `needed()`). */
export function neededFlags(r: QueueItem['result']): AckFlag[] {
  const f: AckFlag[] = [];
  if (r.delta?.status === 'fail') f.push('delta');
  if (r.critical.is_critical) f.push('critical');
  if (r.unit_mismatch) f.push('unit_mismatch');
  if (r.instrument_flags?.length) f.push('instrument_flag');
  return f;
}
/** [CONV] flagged = a flag other than N, a critical value, or a result that needs a flag acknowledgement (cannot be ticked or bulk selected). */
const isFlagged = (r: QueueResult) => (!!r.flag && r.flag !== 'N') || r.critical.is_critical || neededFlags(r).length > 0;
const range = (r: Res) => {
  if (r.range_unavailable_age_unknown) return AGE_UNKNOWN;
  const s = r.reference_range_snapshot;
  if (s?.text) return s.text;
  return s?.low && s.high ? `${s.low}–${s.high}` : s?.low ? `≥ ${s.low}` : s?.high ? `≤ ${s.high}` : DASH;
};
const change = (d: Res['delta']) => (d?.abs ? (d.pct ? `${d.abs} (${d.pct}%)` : d.abs) : DASH);

/** Rows of the same registration grouped, first seen order. */
function group(items: QueueItem[]): Reg[] {
  const m = new Map<string, Reg>();
  for (const i of items) {
    const g = m.get(i.registration_no) ?? { no: i.registration_no, items: [] };
    g.items.push(i as Reg['items'][number]);
    m.set(i.registration_no, g);
  }
  return [...m.values()];
}

type Job = { sig: string; keys: string[]; chunks: VerifyItem[][]; next: number; rows: ResultBulkRow[] };

export function QueueScreen({ mode, items, permissions, onStepUp, currentUserId, pending }: QueueProps & { mode: QueueMode }) {
  const c = COPY[mode];
  const title = t(c.menu);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useNow();
  const canAct = permissions.includes(c.perm) && !pending;
  // T0D-OFFLINE-4 (LD-322 decisions 2 and 3; done_when 2, 3): offline, each sign-off is checked LOCALLY against the cached policy (same reasons as online)
  // and queued as one result.verify; the server checks again at sync. Approval (MFA step up) stays online only.
  const flows = useOfflineFlows();
  const snap = useOfflineSnapshot();
  const offline = mode === 'verify' && !!flows?.verifyResult && !!snap && !isOnline(snap);
  const [selNo, setSelNo] = useState<string>();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [acks, setAcks] = useState<Record<string, AckFlag[]>>({});
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<'mfa' | 'error' | null>(null);
  const [outcome, setOutcome] = useState<ResultBulkRow[] | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [returning, setReturning] = useState<CodedOption[] | null>(null);
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
  const mine = (r: QueueResult) => {
    const ch = chains[r.id];
    return !!currentUserId && Array.isArray(ch) && ch.some((s) => s.signer_user_id === currentUserId && (r.current_version_no === undefined || s.result_version === r.current_version_no));
  };
  const regs = group(items);
  const sendable = (g: Reg) => g.items.filter((i) => !mine(i.result));
  const regMine = (g: Reg) => sendable(g).length === 0 && g.items.some((i) => mine(i.result));
  const regFlagged = (g: Reg) => g.items.some((i) => isFlagged(i.result));
  const tickable = (g: Reg) => canAct && !regFlagged(g) && !regMine(g);
  const sel = regs.find((g) => g.no === selNo);
  const unflagged = regs.filter(tickable);
  const tickedRegs = regs.filter((g) => ticked.has(g.no) && tickable(g));
  const targets = (tickedRegs.length ? tickedRegs : sel ? [sel] : []).flatMap(sendable);
  const blocked = mode === 'verify' && targets.some((i) => neededFlags(i.result).some((f) => !acks[i.result.id]?.includes(f)));
  const verified = (g: Reg) => g.items.map((i) => i.result.verified_at).filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
  // Waiting time: approval = since the oldest verified_at; verification has no timestamp in VerificationQueueItem (contract gap in the notes), so a dash
  const waitMs = (g: Reg) => { const v = verified(g); return mode === 'approve' && v.length ? now - Math.min(...v.map(Date.parse)) : undefined; };
  const waits = regs.map(waitMs).filter((x): x is number => x !== undefined);
  const toggleTick = (no: string, on: boolean) => setTicked((p) => { const n = new Set(p); if (on) n.add(no); else n.delete(no); return n; });
  const toggleAck = (id: string, f: AckFlag, on: boolean) => setAcks((p) => ({ ...p, [id]: on ? [...(p[id] ?? []), f] : (p[id] ?? []).filter((x) => x !== f) }));

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
    setTicked(new Set());
    setAcks({});
    setOutcome(j.rows);
  }

  async function send(list: QueueItem[]) {
    if (busyRef.current || list.length === 0 || !canAct) return;
    const body: VerifyItem[] = list.map((i) => ({
      id: i.result.id,
      version: i.result.version,
      ...(mode === 'verify' && neededFlags(i.result).length ? { acknowledged_flags: [...neededFlags(i.result)].sort() } : {}),
    }));
    if (offline) {
      busyRef.current = true; setBusy(true); setBanner(null);
      const rows: ResultBulkRow[] = [];
      try {
        for (const b of body) {
          const input = { result_id: b.id, ...(b.acknowledged_flags ? { acknowledged_flags: b.acknowledged_flags } : {}) };
          const chk = await flows!.checkVerify!(b.id, input);
          const r = chk.allowed ? await flows!.verifyResult!(input) : { ok: false as const, code: chk.code };
          rows.push(r.ok ? { id: b.id, outcome: 'ok' } : { id: b.id, outcome: 'error', code: r.code });
        }
      } catch (e) {
        rows.push(...body.slice(rows.length).map((x) => ({ id: x.id, outcome: 'error' as const, code: (e as { code?: string }).code ?? 'common.internal' })));
      } finally { busyRef.current = false; setBusy(false); }
      setTicked(new Set()); setAcks({}); setOutcome(rows);
      return;
    }
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
  const primary = () => { if (!blocked) void send(targets); };

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

  // Return for repeat: the existing returnResult operation, once per result of the selected registration (return_reasons read when the dialog opens)
  async function openReturn() {
    if (!canAct || !sel || regMine(sel)) return;
    const r = await call(listCodedSetAction('return_reasons'));
    setReturning(r.ok ? r.data.filter((x) => x.is_active).map(({ code, display }) => ({ code, display })) : []);
  }
  async function doReturn(code: string, comment: string): Promise<string | null> {
    for (const i of sel ? sendable(sel) : []) {
      const r = await call(returnResultAction(i.result.id, i.result.version, { reason_code: code, ...(comment.trim() ? { comment: comment.trim() } : {}) }));
      if (!r.ok) return actionError(r.code);
    }
    setReturning(null);
    router.refresh(); // the returned results leave the queue
    return null;
  }

  const setFlagged = (on: boolean) => {
    const q = new URLSearchParams(params.toString());
    if (on) q.set('flagged_only', 'true'); else q.delete('flagged_only');
    router.push(q.size ? `${pathname}?${q}` : pathname);
  };
  const close = () => { setOutcome(null); if (!offline) router.refresh(); };
  const failed = (outcome ?? []).filter((o) => o.outcome === 'error');
  const byId = new Map(items.map((i) => [i.result.id, i]));
  const allResults = unflagged.flatMap(sendable);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 's' && canAct && unflagged.length) { e.preventDefault(); setConfirmAll(true); }
    else if (k === c.key && canAct && targets.length && !busy) { e.preventDefault(); primary(); }
    else if (k === 'r' && canAct && sel) { e.preventDefault(); void openReturn(); }
  };

  // 04-UI-UX §3.8 "Bulk select (Space, Shift+↓)": Shift+ArrowDown ticks this and the next tickable registration and moves focus to its box (j/k stay with SplitConsole)
  // T0D-UIX-3: the kit grid (react-aria) takes Space and the arrow keys in its cells, so the box keys are read in the CAPTURE phase above the grid.
  const onTickKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const box = e.target instanceof HTMLInputElement ? e.target : null;
    const g = box?.dataset.queueTick ? regs.find((r) => r.no === box.dataset.queueTick) : undefined;
    if (!box || !g || !tickable(g)) return;
    if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleTick(g.no, !ticked.has(g.no)); return; }
    if (e.key !== 'ArrowDown' || !e.shiftKey) return;
    e.preventDefault(); e.stopPropagation();
    const next = regs.slice(regs.indexOf(g) + 1).find(tickable);
    setTicked((p) => new Set([...p, g.no, ...(next ? [next.no] : [])]));
    if (next) [...e.currentTarget.querySelectorAll<HTMLInputElement>('[data-queue-tick]')].find((x) => x.dataset.queueTick === next.no)?.focus();
  };

  // T0D-UIX-3 (LD-442): the queue and the results are kit DataTables (header kept when empty, numbers end aligned).
  // The queue item stays ONE focusable button (data-console-item for SplitConsole j / k); its row carries the selection and the dimming (domAttrs onRow).
  type Item = Reg['items'][number];
  const queueCols: ColumnDef<Reg>[] = [
    { id: 'priority', header: 'Priority', cell: (g) => g.items[0]!.priority },
    { id: 'reg', header: 'Registration no', isRowHeader: true, cell: (g) => {
      const dim = regMine(g);
      // onFocus stops at the box: otherwise the grid row takes the focus back from it (T0D-UIX-3)
      return (
        <>
          <input type="checkbox" aria-label={`Select ${g.no}`} data-queue-tick={g.no} checked={tickable(g) && ticked.has(g.no)} disabled={!tickable(g)} {...(!tickable(g) ? { title: !canAct ? c.denied : dim ? MINE : 'Flagged: open it and review each result' } : {})} onChange={(e) => toggleTick(g.no, e.target.checked)} onFocus={(e) => e.stopPropagation()} />{' '}
          {/* T0D-UIX-3 review: same for the item button, so SplitConsole j / k keep the focus they move */}
          <span onFocus={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm" ref={domAttrs({ 'data-console-item': g.no })} onPress={() => setSelNo(g.no)}>
              <span ref={domAttrs({ 'aria-selected': String(selNo === g.no), 'data-selected': selNo === g.no ? 'true' : undefined, 'aria-disabled': dim ? 'true' : undefined, style: dim ? 'opacity: 0.55' : undefined }, true)}>{g.no}</span>
            </Button>
          </span>
        </>
      );
    } },
    { id: 'patient', header: 'Patient', cell: (g) => g.items[0]!.patient_display.full_name },
    { id: 'count', header: 'Analyte count', numeric: true, cell: (g) => String(g.items.length) },
    { id: 'flags', header: 'Flags', cell: (g) => {
      const next = g.items[0]!.result.next_step;
      return (
        <>
          {[...new Set(g.items.map((i) => i.result.flag).filter((f): f is string => !!f && f !== 'N'))].map((f) => <FlagBadge key={f} flag={f as ResultFlag} />)}
          {next && NEXT[next] ? <span>{NEXT[next]}</span> : null}
          {regMine(g) ? <div>{MINE}</div> : null}
        </>
      );
    } },
    { id: 'wait', header: 'Waiting time', numeric: true, cell: (g) => { const w = waitMs(g); return <span suppressHydrationWarning>{w === undefined ? DASH : hhmm(w)}</span>; } },
  ];
  const resultCols: ColumnDef<Item>[] = [
    { id: 'analyte', header: 'Analyte', isRowHeader: true, cell: (i) => i.result.analyte_code },
    { id: 'value', header: 'Value', numeric: true, cell: (i) => i.result.value_numeric ?? i.result.value_text ?? DASH },
    { id: 'unit', header: 'Unit', cell: (i) => i.result.unit_code ?? DASH },
    { id: 'range', header: 'Reference range', cell: (i) => range(i.result) },
    { id: 'flag', header: 'Flag', cell: (i) => {
      const r = i.result;
      const need = mode === 'verify' ? neededFlags(r) : [];
      return (
        <>
          {r.flag ? <FlagBadge flag={r.flag as ResultFlag} /> : null}
          {canAct ? need.map((f) => (
            <Checkbox key={f} label={`Acknowledge ${FLAG_LABEL[f]}`} isSelected={acks[r.id]?.includes(f) ?? false} onChange={(on) => toggleAck(r.id, f, on)} />
          )) : null}
        </>
      );
    } },
    { id: 'prev', header: 'Previous value', numeric: true, cell: (i) => i.result.delta?.prev_value ?? DASH },
    { id: 'change', header: 'Change', numeric: true, cell: (i) => change(i.result.delta) },
    { id: 'comment', header: 'Comment', cell: (i) => i.result.comment_text ?? DASH },
    { id: 'signoff', header: 'Sign-off', cell: (i) => {
      const r = i.result;
      return (
        <>
          {r.signoff_count !== undefined && r.signoff_required !== undefined ? (
            <SignoffCell listId={`${uid}-${r.id}`} count={r.signoff_count} required={r.signoff_required} next={r.next_step} chain={chains[r.id]}
              open={openChip === r.id} onToggle={() => setOpenChip((o) => (o === r.id ? null : r.id))} />
          ) : DASH}
          {mine(r) ? <div>{MINE}</div> : null}
          <PendingSyncBadge id={r.id} />
        </>
      );
    } },
  ];

  const list = (
    <DataTable caption={`${title} queue`} columns={queueCols} rows={regs} getRowId={(g) => g.no} cellTitle
      emptyState={pending ? { title: 'Not available yet', body: NOT_YET } : { title: c.empty }} />
  );

  const detail = sel ? (
    <>
      {/* T0D-UIGUARD-1-LAB (LD-436 rule 7): heading semantics without a raw h2 */}
      <p role="heading" aria-level={2} className="lims-card-title">{sel.items[0]!.patient_display.full_name}</p>
      <p className="lims-console-strip">
        {[sel.items[0]!.patient_display.age_sex, sel.items[0]!.patient_display.patient_code, sel.no, sel.items[0]!.priority].join(' · ')}
        {permissions.includes('lab.result.enter') ? <> · <a className="lims-link" href="/lab/worklists">Open worklists</a></> : null}
      </p>
      <DataTable caption="Results" columns={resultCols} rows={sel.items} getRowId={(i) => i.result.id} cellTitle emptyState={{ title: 'No results.' }} />
      <p data-console-audit="">{auditLine(sel, chains)}</p>
    </>
  ) : <p>{pending ? NOT_YET : regs.length ? 'Select a registration to see its results here.' : c.empty}</p>;

  const why = !canAct ? (pending ? null : c.denied) : sel && !tickedRegs.length && regMine(sel) ? MINE : null;
  const actions = (
    <>
      {why ? <p>{why}</p> : null}
      <Button isDisabled={!canAct || unflagged.length === 0 || busy} onPress={() => setConfirmAll(true)}>Select all unflagged (S)</Button>
      <Button variant="primary" isLoading={busy} isDisabled={!canAct || targets.length === 0 || blocked} onPress={primary}>
        {targets.length ? `${c.verb} ${targets.length} (${c.key.toUpperCase()})` : `${c.verb} (${c.key.toUpperCase()})`}
      </Button>
      <Button isDisabled={!canAct || !sel || regMine(sel) || busy} onPress={() => void openReturn()}>Return for repeat (R)</Button>
      {/* No hold operation exists for a queued result (gap in the notes): shown, disabled, with the reason */}
      <Button isDisabled ref={domAttrs({ title: 'Hold is not available yet' })}>Hold (H)</Button>
    </>
  );

  return (
    <section aria-label={title}>
      <PageHeader title={title} helpKey={`lab.${mode}`} />
      {/* T0D-UIGUARD-1-LAB (LD-353 rule 2, LD-441): the kit FilterBar row around the one switch */}
      <FilterBar>
        <Checkbox label="Flagged only" isSelected={params.get('flagged_only') === 'true'} onChange={setFlagged} />
      </FilterBar>
      <StatTileRow>
        <StatTile label="Pending" value={String(regs.length)} />
        <StatTile label="Flagged" value={String(regs.filter(regFlagged).length)} />
        <StatTile label="Oldest wait" value={waits.length ? hhmm(Math.max(...waits)) : DASH} />
      </StatTileRow>
      {banner === 'mfa' ? (
        <div role="alert"><Banner tone="warning" title={MFA} action={{ label: 'Verify now', onPress: () => void verifyNow() }} /></div>
      ) : banner === 'error' ? (
        <div role="alert"><Banner tone="danger" title={FAILED} /></div>
      ) : null}
      <div onKeyDown={onKey} onKeyDownCapture={onTickKey}>
        <SplitConsole list={list} detail={detail} actions={actions} listLabel={`${title} queue`} detailLabel="Registration" />
      </div>
      <ConfirmDialog title={`${c.verb} all unflagged`} isOpen={confirmAll} confirmLabel="Confirm" onCancel={() => setConfirmAll(false)}
        body={<p>{`${c.verb} ${unflagged.length} registrations, ${allResults.length} results.`}</p>}
        onConfirm={() => { setConfirmAll(false); void send(allResults); }} />
      {returning ? <ReturnDialog reasons={returning} onCancel={() => setReturning(null)} onReturn={doReturn} /> : null}
      <Dialog title={c.done} isOpen={outcome !== null} onClose={close}>
        <p>{`${(outcome?.length ?? 0) - failed.length} done, ${failed.length} not done`}</p>
        {failed.length ? (
          <div role="list">
            {failed.map((o) => {
              const i = byId.get(o.id);
              const ev = o.code === 'lab.critical_ack_required' ? i?.result.critical.critical_event_id : undefined;
              return (
                <div role="listitem" key={o.id}>
                  {`${i ? `${i.registration_no} · ${i.patient_display.full_name} · ${i.result.analyte_code}` : 'Result'}: `}<span>{reason(o.code)}</span>
                  {ev ? <> <a href={`/lab/critical-values/${encodeURIComponent(ev)}`}>Open critical value</a></> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}

/** "Audit · AN1: Name · title · role · time; ..." from the loaded sign-off chains (plain text). */
function auditLine(g: Reg, chains: Record<string, Chain>) {
  const parts = g.items.flatMap((i) => {
    const ch = chains[i.result.id];
    if (!Array.isArray(ch) || ch.length === 0) return [];
    return [`${i.result.analyte_code}: ${ch.map((s) => [s.signer_display_name, s.signer_title, s.signer_role_code.replace(/_/g, ' '), utc(s.signed_at)].filter(Boolean).join(' · ')).join(', ')}`];
  });
  return `Audit · ${parts.length ? parts.join('; ') : 'no sign-offs recorded yet'}`;
}

/** T0D-VERLEVEL-1: "Signed n of m" chip (a button, so the keyboard reaches it), the next step label and, when open, who signed (plain text, never markup). */
function SignoffCell({ listId, count, required, next, chain, open, onToggle }: {
  listId: string; count: number; required: number; next: string | undefined; chain: Chain | undefined; open: boolean; onToggle: () => void;
}) {
  const rows = Array.isArray(chain) ? chain : [];
  return (
    <div>
      {/* T0D-UIX-3 (LD-442): kit Button; aria-expanded / aria-controls through domAttrs */}
      <Button variant="ghost" size="sm" ref={domAttrs({ 'aria-expanded': String(open), 'aria-controls': open ? listId : undefined })} onPress={onToggle}>{`Signed ${count} of ${required}`}</Button>
      {next && NEXT[next] ? <> <span>{NEXT[next]}</span></> : null}
      {open ? (
        chain === 'error' ? <p id={listId}>Could not load who signed.</p>
          : count === 0 || (chain && rows.length === 0) ? <p id={listId}>No sign-offs yet.</p>
          : !chain ? <p id={listId} role="status">Loading…</p>
          : (
            <div role="list" id={listId} aria-label="Signed by">
              {rows.map((s) => (
                <div role="listitem" key={`${s.result_version}-${s.seq}`}>
                  <span>{s.signer_display_name}</span>{[s.signer_title, s.signer_role_code.replace(/_/g, ' '), utc(s.signed_at)].filter(Boolean).map((x) => ` · ${x}`).join('')}
                </div>
              ))}
            </div>
          )
      ) : null}
    </div>
  );
}

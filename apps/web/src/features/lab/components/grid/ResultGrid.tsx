'use client';
// C5.T-20 — result entry grid /lab/orders/{order_id}/results (04-UI-UX §3.6 + §3.7; PRD AC-08.1, AC-08.4, AC-09.2, AC-09.3, AC-10.1, AC-11.1, AC-11.2).
// Built on the UI kit EditableGrid (string cells, per-column read-only, Enter/F2 = edit). The §3.6 keyboard table is handled by ONE capture-phase keydown listener on the document, so
// every shortcut also works while focus is in a dialog, the history panel or the comment box; the kit grid is only steered (type-to-edit, Enter → next editable row, per-row read-only).
// The comment box (T-18 CommentCell) lives in an extra cell appended to each row (React portal) because kit cells hold text only.
// LD-25 (2026-11-07, A33-2 downtime mode): "Downtime back-entry" switch → bulk-enter carries entry_mode 'downtime_backentry', occurred_at (original paper-form time, <= now, >= now - downtime_backentry_max_hours,
// default 72) and downtime_ref (paper form serial, <= 32). The API re-checks every limit; this only saves a round trip. No back-dating of anything else.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const useLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect; // no SSR warning
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { EditableGrid, type EditableGridColumn, type EditableGridRow } from '@lims/ui/components/EditableGrid';
import { KeyboardShortcutsDialog } from '@lims/ui/components/KeyboardShortcutsDialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { StatusStepper } from '@lims/ui/components/StatusStepper';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { Tooltip } from '@lims/ui/components/Tooltip';
import { useToast } from '@lims/ui/components/Toast';
import {
  amendResultAction, bulkApproveAction, bulkEnterAction, bulkVerifyAction, getAnalyteTrendAction, getResultHistoryAction, listCommentCodesAction, returnResultAction,
} from '../../server/actions';
import type { AckFlag, AmendBody, CodedOption, DowntimeFields, EnterEntry, GridResult, HistoryRow, OrderResults, TrendResponse, VerifyItem } from '../../server/types';
import { FAILED, call, newKey } from '../shared';
import { CommentCell } from './CommentCell';
import { AmendDialog, ReturnDialog, VerifyPrompt } from './ResultDialogs';
import { HistoryPanel, TrendDialog } from './ResultPanels';
import {
  DOWNTIME_DEFAULT_MAX_HOURS, DOWNTIME_REF_MAX, actionError, formatDateTime, calcText, deltaText, enterError, flagText, isEditable, neededFlags, nameOf, provenanceText, rangeText, statusLabel,
  validateDowntime, validateValue, valueField, valueOf, type AnalyteMap,
} from './resultModel';

export interface ResultGridProps {
  data: OrderResults;
  /** Catalog facts the ResultDto does not carry (SPEC GAP): analyte name, decimals, value type. Missing → the analyte code and up to 6 decimals. */
  analytes?: AnalyteMap;
  permissions: readonly string[];
  /** getAnalyteTrend needs it and neither LabOrderDto nor ResultDto carries it (SPEC GAP). Missing → F3 says the trend is unavailable. */
  patientId?: string;
  returnReasons: readonly CodedOption[];
  amendmentReasons: readonly CodedOption[];
  /** tenant setting downtime_backentry_max_hours (LD-25), default 72 */
  downtimeMaxHours?: number;
  /** Alt+N / Alt+P targets (worklist context) */
  worklist?: { prevOrderId?: string; nextOrderId?: string };
  /** step-up for 403 auth.mfa_required; default = page reload (no C2 step-up route in the spec, same as the approval queue) */
  onStepUp?: () => Promise<void> | void;
}

type Edit = { value?: string; comment?: { text: string; codes: string[] } };
type Modal = { kind: 'verify'; rows: { result: GridResult; flags: AckFlag[] }[]; resolve: (a: Record<string, AckFlag[]> | null) => void }
  | { kind: 'return' | 'amend'; id: string } | { kind: 'leave'; to: string } | { kind: 'shortcuts' };

const COLS: EditableGridColumn[] = [
  { id: 'analyte', header: 'Analyte', isReadOnly: true },
  { id: 'value', header: 'Value', maxLength: 2000 },
  { id: 'unit', header: 'Unit', isReadOnly: true },
  { id: 'flag', header: 'Flag', isReadOnly: true },
  { id: 'range', header: 'Ref range', isReadOnly: true },
  { id: 'delta', header: 'Δ', isReadOnly: true },
  { id: 'calc', header: 'Calculation', isReadOnly: true },
  { id: 'origin', header: 'Origin', isReadOnly: true },
  { id: 'downtime', header: 'Entry', isReadOnly: true },
  { id: 'test', header: 'Test', isReadOnly: true },
];
const VALUE_COL = 1; // index in COLS
const ORIGIN_COL = 7; // index in COLS
const ORIGIN_PREFIX = 'origin:';
// RS-C5 (LD-140, 10-DESIGN-SYSTEM s4): three-step track. Rank of a result = the step it has reached; the item sits at its least advanced result.
const TRACK = [{ id: 'entered', label: 'Entered' }, { id: 'senior', label: 'Senior technician' }, { id: 'pathologist', label: 'Pathologist' }] as const;
const RANK: Record<string, number> = { resulted: 0, verified: 1, approved: 2 };
const stepOf = (statuses: readonly string[]) => {
  const live = statuses.filter((s) => s !== 'cancelled');
  return live.length && live.every((s) => s in RANK) ? Math.min(...live.map((s) => RANK[s]!)) : -1; // any pending result: nothing entered yet for the item
};
const MFA = 'Approval needs a second check. Verify your identity, then the approval is sent again.';
const MAX_BATCH = 200; // OpenAPI maxItems
const SHORTCUTS = [
  { keys: 'Enter', description: 'Start / commit the edit of a value; after a commit, go to the next editable row' },
  { keys: 'Shift+Enter', description: 'Previous editable row' },
  { keys: 'Tab', description: 'Next cell in the row' }, { keys: 'Shift+Tab', description: 'Previous cell in the row' },
  { keys: 'Esc', description: 'Cancel the current cell edit' },
  { keys: 'Ctrl+S', description: 'Save all edited rows' }, { keys: 'Ctrl+Enter', description: 'Save, then verify the rows of the focused test' },
  { keys: 'F2', description: 'Show / hide the history of the focused analyte' }, { keys: 'F3', description: 'Trend chart of the focused analyte' },
  { keys: 'Ctrl+Space', description: 'Comment code picker (in a comment box)' }, { keys: 'Space', description: 'Select / unselect the focused verified result for approval' },
  { keys: 'Alt+A', description: 'Approve the selected results' }, { keys: 'Alt+R', description: 'Return the focused verified result' }, { keys: 'Alt+M', description: 'Amend the focused approved result' },
  { keys: 'Alt+N', description: 'Next order of the worklist' }, { keys: 'Alt+P', description: 'Previous order of the worklist' }, { keys: '?', description: 'This list' },
];
const SHORTCUT_GROUPS = [{ id: 'grid', title: 'Result entry grid', shortcuts: SHORTCUTS }];

const isTextTarget = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function ResultGrid({ data, analytes = {}, permissions, patientId, returnReasons, amendmentReasons, downtimeMaxHours = DOWNTIME_DEFAULT_MAX_HOURS, worklist, onStepUp }: ResultGridProps) {
  const router = useRouter();
  const toast = useToast();
  const can = (p: string) => permissions.includes(p);
  const canEnter = can('lab.result.enter'), canVerify = can('lab.result.verify'), canApprove = can('lab.result.approve'), canAmend = can('lab.result.amend');

  const index = (d: OrderResults) => Object.fromEntries(d.items.flatMap((i) => i.results).map((r) => [r.id, r]));
  const [results, setResultsState] = useState<Record<string, GridResult>>(() => index(data));
  const resultsRef = useRef(results);
  const setResults = (f: (p: Record<string, GridResult>) => Record<string, GridResult>) => { resultsRef.current = f(resultsRef.current); setResultsState(resultsRef.current); };
  const [edits, setEditsState] = useState<Record<string, Edit>>({});
  const editsRef = useRef(edits);
  const setEdits = (f: (p: Record<string, Edit>) => Record<string, Edit>) => { editsRef.current = f(editsRef.current); setEditsState(editsRef.current); };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [banner, setBanner] = useState<{ kind: 'error' | 'mfa'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [history, setHistory] = useState<{ title: string; rows: HistoryRow[] } | null>(null);
  const [trend, setTrend] = useState<{ title: string; unit?: string | undefined; data: TrendResponse } | null>(null);
  const [dtOn, setDtOn] = useState(false);
  const [dtAt, setDtAt] = useState('');
  const [dtRef, setDtRef] = useState('');
  const [dtErr, setDtErr] = useState<{ at?: string; ref?: string }>({});
  const busyRef = useRef(false);
  const loadingRef = useRef(false);
  const focusedRow = useRef(0);
  const attempt = useRef<{ sig: string; key: string } | null>(null);   // an identical retry after a failure reuses its Idempotency-Key (02-CONVENTIONS §4.5)
  const approveJob = useRef<{ sig: string; key: string; items: VerifyItem[] } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<Record<string, HTMLElement>>({});

  // server data changed (router.refresh): take it; typed edits stay
  const seen = useRef(data);
  useEffect(() => { if (seen.current !== data) { seen.current = data; setResults(() => index(data)); } }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = data.items.flatMap((item) => item.results.map((r0) => ({ item, id: r0.id, r0 })));
  const rowsInfo = flat.map(({ item, id, r0 }) => ({ item, r: results[id] ?? r0 }));
  const info = (r: GridResult) => analytes[r.analyte_id];
  const editable = (r: GridResult) => canEnter && isEditable(r);
  const hasEdits = Object.values(edits).some((e) => e.value !== undefined || e.comment !== undefined);

  const gridRows: EditableGridRow[] = rowsInfo.map(({ item, r }) => {
    const e = edits[r.id];
    const shown = e?.value ?? valueOf(r);
    const down = r.entry_mode === 'downtime_backentry' ? `Entered after downtime${r.occurred_at ? ` · ${formatDateTime(r.occurred_at)}` : ''}` : '';
    const text = [statusLabel(r), e ? 'Unsaved changes' : '', selected.has(r.id) ? 'Selected' : ''].filter(Boolean).join(' · ');
    return {
      id: r.id,
      values: {
        analyte: `${nameOf(r, analytes)} ${r.analyte_code}`, value: shown, unit: r.unit_code ?? '', flag: flagText(r.flag), range: rangeText(r), delta: deltaText(r), calc: calcText(r),
        origin: r.origin === 'instrument' ? '' : r.origin[0]!.toUpperCase() + r.origin.slice(1), downtime: down, test: item.test.test_code, // instrument: the chip is portalled into the cell (RS-C5, LD-140)
      },
      status: errors[r.id] ? 'error' : e ? 'unsaved' : 'saved',
      statusText: text,
      ...(errors[r.id] ? { errors: { value: errors[r.id]! } } : {}),
    };
  });

  // ── extra comment cell + per-row read-only (the kit only knows per-column read-only)
  useLayout(() => {
    const el = box.current;
    if (!el) return;
    const next: Record<string, HTMLElement> = {};
    el.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr, i) => {
      const row = rowsInfo[i];
      if (!row) return;
      let td = tr.querySelector<HTMLElement>(':scope > td[data-slot]');
      if (!td) {
        td = document.createElement('td');
        td.setAttribute('role', 'gridcell');
        td.setAttribute('data-slot', 'comment');
        td.setAttribute('aria-colindex', String(COLS.length + 2));
        tr.appendChild(td);
      }
      next[row.r.id] = td;
      const oc = tr.children[ORIGIN_COL];
      if (row.r.origin === 'instrument' && oc instanceof HTMLElement) next[`${ORIGIN_PREFIX}${row.r.id}`] = oc;
      const vc = tr.children[VALUE_COL];
      if (editable(row.r)) vc?.removeAttribute('aria-readonly'); else vc?.setAttribute('aria-readonly', 'true');
    });
    const head = el.querySelector('thead tr');
    if (head && !head.querySelector('[data-slot]')) {
      const th = document.createElement('th');
      th.setAttribute('role', 'columnheader');
      th.setAttribute('scope', 'col');
      th.setAttribute('data-slot', 'comment');
      th.setAttribute('aria-colindex', String(COLS.length + 2));
      th.textContent = 'Comment';
      head.appendChild(th);
    }
    setSlots((p) => (Object.keys(next).length === Object.keys(p).length && Object.keys(next).every((k) => p[k] === next[k]) ? p : next));
  });

  const cellOf = (idx: number, col = VALUE_COL) => box.current?.querySelector<HTMLElement>(`tbody tr[aria-rowindex="${idx + 2}"] > [role=gridcell][aria-colindex="${col + 1}"]`) ?? null;
  const rowIdx = (t: EventTarget | null) => {
    const tr = t instanceof Element ? t.closest('tbody tr[role=row]') : null;
    return tr && box.current?.contains(tr) ? Number(tr.getAttribute('aria-rowindex')) - 2 : -1;
  };
  /** Focus the Value cell of the next / previous editable row (calculated and locked rows are skipped). */
  const moveEditable = (from: number, dir: 1 | -1) => {
    for (let j = from + dir; j >= 0 && j < rowsInfo.length; j += dir) if (editable(rowsInfo[j]!.r)) { cellOf(j)?.focus(); return; }
    cellOf(from)?.focus();
  };
  /** Type-to-edit: start the kit's edit mode (Enter), then replace the draft by the typed character. */
  const startTyping = (cell: HTMLElement, ch: string) => {
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const seed = (left: number) => {
      const input = cell.querySelector('input');
      if (!input) { if (left > 0) setTimeout(() => seed(left - 1), 0); return; }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ch);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setSelectionRange?.(ch.length, ch.length);
    };
    setTimeout(() => seed(5), 0);
  };

  // ── cell edit commit from the kit grid (client side of AC-08.3 / AC-08.6)
  const onCellChange = (rowId: string, _col: string, draft: string) => {
    const r = resultsRef.current[rowId];
    if (!r || !editable(r)) return;
    const text = draft.trim();
    if (text === '') { setEdits((p) => { const { [rowId]: e, ...rest } = p; return e?.comment ? { ...rest, [rowId]: { comment: e.comment } } : rest; }); setErrors(({ [rowId]: _x, ...rest }) => rest); return; }
    const bad = validateValue(text, info(r));
    setEdits((p) => ({ ...p, [rowId]: { ...p[rowId], value: text } }));
    setErrors(({ [rowId]: _x, ...rest }) => (bad ? { ...rest, [rowId]: bad } : rest));
  };
  const onComment = (rowId: string, c: { text: string; codes: string[] }) => setEdits((p) => ({ ...p, [rowId]: { ...p[rowId], comment: c } }));

  // ── save (Ctrl+S): ONE bulk-enter with the edited rows. Returns the merged results (also when nothing was sent) or null when blocked / failed.
  async function save(): Promise<Record<string, GridResult> | null> {
    if (!canEnter) return resultsRef.current;
    if (busyRef.current) return null;
    const entries: EnterEntry[] = [];
    for (const { r } of rowsInfo) {
      const e = editsRef.current[r.id];
      if (!e || !isEditable(r)) continue;
      const value = e.value ?? valueOf(r);
      if (e.value !== undefined && validateValue(e.value, info(r))) continue;       // flagged inline, not sent
      if (value === '') continue;                                                    // a comment alone cannot create a result
      if ((e.comment?.text.length ?? 0) > 1000) { setErrors((p) => ({ ...p, [r.id]: 'Comment is limited to 1,000 characters.' })); continue; }
      entries.push({ result_id: r.id, version: r.version, ...valueField(value, info(r)), ...(e.comment?.codes.length ? { comment_codes: e.comment.codes } : {}), ...(e.comment?.text ? { comment_text: e.comment.text } : {}) });
    }
    if (entries.length === 0) return resultsRef.current;
    if (entries.length > MAX_BATCH) { setBanner({ kind: 'error', text: `Save at most ${MAX_BATCH} results at a time.` }); return null; }
    let downtime: DowntimeFields | undefined;
    if (dtOn) {
      const v = validateDowntime(dtAt, dtRef, downtimeMaxHours);
      setDtErr({ ...(v.at ? { at: v.at } : {}), ...(v.ref ? { ref: v.ref } : {}) });
      if (v.at || v.ref || !v.occurredAt) return null;
      downtime = { entry_mode: 'downtime_backentry', occurred_at: v.occurredAt, downtime_ref: dtRef };
    }
    const sig = JSON.stringify([entries, downtime]);
    const key = attempt.current?.sig === sig ? attempt.current.key : newKey();
    attempt.current = { sig, key };
    busyRef.current = true; setBusy(true); setBanner(null);
    try {
      const r = await call(bulkEnterAction(entries, key, downtime));
      if (!r.ok) { setBanner({ kind: 'error', text: r.code === 'common.rate_limited' ? actionError(r.code) : FAILED }); return null; }
      attempt.current = null;
      const next = { ...resultsRef.current };
      const nextErr: Record<string, string> = {};
      const done: string[] = [];
      for (const row of r.data.results) {
        if (row.outcome === 'ok') { if (row.result) next[row.result_id] = row.result; done.push(row.result_id); }
        else nextErr[row.result_id] = enterError(row.code, analytes[next[row.result_id]?.analyte_id ?? '']);
      }
      for (const c of r.data.recomputed ?? []) next[c.id] = c;
      setResults(() => next);
      setEdits((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !done.includes(id))));
      setErrors((p) => ({ ...Object.fromEntries(Object.entries(p).filter(([id]) => !done.includes(id))), ...nextErr }));
      return Object.keys(nextErr).length ? null : next;
    } finally { busyRef.current = false; setBusy(false); }
  }

  // ── verify (Ctrl+Enter): save, then verify the rows of the focused test; flagged rows need one tick per flag first
  async function saveAndVerify(idx: number) {
    if (!canVerify) return;
    const merged = await save();
    if (!merged) return;
    const item = flat[idx]?.item ?? flat[0]?.item;
    const mine = (item?.results ?? []).map((x) => merged[x.id]!).filter((r) => r.status === 'resulted');
    if (mine.length === 0) return;
    const flagged = mine.map((result) => ({ result, flags: neededFlags(result) })).filter((x) => x.flags.length);
    let acks: Record<string, AckFlag[]> = {};
    if (flagged.length) {
      const a = await new Promise<Record<string, AckFlag[]> | null>((resolve) => setModal({ kind: 'verify', rows: flagged, resolve }));
      setModal(null);
      if (!a) return;
      acks = a;
    }
    const items: VerifyItem[] = mine.map((r) => ({ id: r.id, version: r.version, ...(neededFlags(r).length ? { acknowledged_flags: [...(acks[r.id] ?? neededFlags(r))].sort() } : {}) }));
    busyRef.current = true; setBusy(true);
    try {
      const r = await call(bulkVerifyAction(items, newKey()));
      if (!r.ok) { setBanner({ kind: 'error', text: FAILED }); return; }
      applyOutcome(r.data, 'verified', 'Verified');
    } finally { busyRef.current = false; setBusy(false); }
  }

  /** bulk verify / approve outcomes (ids + outcome only): ok rows move on locally (+1 version, refreshed from the server right after), failed rows keep a readable reason. */
  function applyOutcome(rows: { id: string; outcome: 'ok' | 'error'; code?: string }[], status: GridResult['status'], word: string) {
    const ok = rows.filter((x) => x.outcome === 'ok').map((x) => x.id);
    setResults((p) => ({ ...p, ...Object.fromEntries(ok.filter((id) => p[id]).map((id) => [id, { ...p[id]!, status, version: p[id]!.version + 1 }])) }));
    setErrors((p) => ({ ...Object.fromEntries(Object.entries(p).filter(([id]) => !ok.includes(id))), ...Object.fromEntries(rows.filter((x) => x.outcome === 'error').map((x) => [x.id, actionError(x.code)])) }));
    setSelected((p) => new Set([...p].filter((id) => !ok.includes(id))));
    if (ok.length) { toast.show({ tone: 'success', title: `${word} ${ok.length}.` }); router.refresh(); }
  }

  // ── approve (Alt+A): selected verified rows; 403 auth.mfa_required → "Verify now" → same request, same key
  async function approve() {
    if (!canApprove || busyRef.current) return;
    const items: VerifyItem[] = rowsInfo.filter(({ r }) => selected.has(r.id) && r.status === 'verified').map(({ r }) => ({ id: r.id, version: r.version }));
    if (items.length === 0) return;
    if (items.length > MAX_BATCH) { setBanner({ kind: 'error', text: `Approve at most ${MAX_BATCH} results at a time.` }); return; }
    const sig = JSON.stringify(items);
    if (approveJob.current?.sig !== sig) approveJob.current = { sig, key: newKey(), items };
    busyRef.current = true; setBusy(true); setBanner(null);
    try {
      const r = await call(bulkApproveAction(items, approveJob.current.key));
      if (!r.ok) { setBanner(r.status === 403 && r.code === 'auth.mfa_required' ? { kind: 'mfa', text: MFA } : { kind: 'error', text: actionError(r.code) }); if (!(r.status === 403 && r.code === 'auth.mfa_required')) approveJob.current = null; return; }
      approveJob.current = null;
      applyOutcome(r.data, 'approved', 'Approved');
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function verifyNow() {
    if (busyRef.current || !approveJob.current) return;
    busyRef.current = true;
    try { await (onStepUp ?? (() => { window.location.reload(); return new Promise<void>(() => undefined); }))(); } catch { busyRef.current = false; return; }
    busyRef.current = false;
    void approve();
  }

  // ── return / amend
  const modalRow = () => (modal && (modal.kind === 'return' || modal.kind === 'amend') ? results[modal.id] : undefined);
  async function doReturn(code: string, comment: string): Promise<string | null> {
    const r0 = modalRow();
    if (!r0) return null;
    const r = await call(returnResultAction(r0.id, r0.version, { reason_code: code, ...(comment.trim() ? { comment: comment.trim() } : {}) }));
    if (!r.ok) return actionError(r.code);
    setResults((p) => ({ ...p, [r0.id]: r.data })); setModal(null);
    toast.show({ tone: 'success', title: 'Returned for correction.' });
    return null;
  }
  async function doAmend(body: AmendBody): Promise<string | null> {
    const r0 = modalRow();
    if (!r0) return null;
    const r = await call(amendResultAction(r0.id, r0.version, body, newKey()));
    if (!r.ok) return actionError(r.code);
    setResults((p) => ({ ...p, [r0.id]: r.data })); setModal(null);
    toast.show({ tone: 'success', title: `Amended to version ${r0.current_version_no + 1}.` });
    return null;
  }

  // ── history (F2, toggles) / trend (F3)
  async function toggleHistory(idx: number) {
    if (history) { setHistory(null); return; }
    const r = results[flat[idx]?.id ?? ''];
    if (!r || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const h = await call(getResultHistoryAction(r.id));
      if (h.ok) setHistory({ title: nameOf(r, analytes), rows: h.data }); else toast.show({ tone: 'danger', title: 'Could not load the history.' });
    } finally { loadingRef.current = false; }
  }
  async function openTrend(idx: number) {
    const r = results[flat[idx]?.id ?? ''];
    if (!r || loadingRef.current) return;
    if (!patientId) { toast.show({ tone: 'neutral', title: 'The trend is not available for this order.' }); return; }
    loadingRef.current = true;
    try {
      const t = await call(getAnalyteTrendAction(patientId, r.analyte_id));
      if (t.ok) setTrend({ title: nameOf(r, analytes), unit: r.unit_code, data: t.data }); else toast.show({ tone: 'danger', title: 'Could not load the trend.' });
    } finally { loadingRef.current = false; }
  }

  // ── Alt+N / Alt+P with the unsaved-changes guard (ConfirmDialog)
  const go = (id?: string) => {
    if (!id) return;
    if (Object.values(editsRef.current).some((e) => e.value !== undefined || e.comment !== undefined)) setModal({ kind: 'leave', to: id });
    else router.push(`/lab/orders/${id}/results`);
  };
  useEffect(() => {
    if (!hasEdits) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [hasEdits]);

  // ── the one keydown listener (capture phase: runs before the kit grid and before dialogs see the key)
  const onKey = (e: KeyboardEvent) => {
    const t = e.target;
    const mod = e.ctrlKey || e.metaKey;
    if (modal || history || trend) {                          // a dialog / panel owns the keyboard; F2 also closes the history panel
      if (e.key === 'F2' && history && !modal) { e.preventDefault(); e.stopPropagation(); setHistory(null); }
      return;
    }
    const inBox = t instanceof Element && !!box.current?.contains(t);
    const idx = inBox ? rowIdx(t) : focusedRow.current;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey && e.key.toLowerCase() === 's') { stop(); if (t instanceof HTMLInputElement && inBox) t.blur(); void save(); return; }
    if (mod && !e.altKey && e.key === 'Enter') { stop(); if (t instanceof HTMLInputElement && inBox) t.blur(); void saveAndVerify(idx); return; }
    if (e.key === 'F2' && !mod && !e.altKey) { stop(); void toggleHistory(idx); return; }
    if (e.key === 'F3' && !mod && !e.altKey) { stop(); void openTrend(idx); return; }
    if (e.altKey && !mod) {
      const k = e.code.replace('Key', '').toLowerCase() || e.key.toLowerCase();
      const r = results[flat[idx]?.id ?? ''];
      if (k === 'a') { stop(); void approve(); }
      else if (k === 'r') { stop(); if (r && canVerify && r.status === 'verified') setModal({ kind: 'return', id: r.id }); }
      else if (k === 'm') { stop(); if (r && canAmend && r.status === 'approved') setModal({ kind: 'amend', id: r.id }); }
      else if (k === 'n') { stop(); go(worklist?.nextOrderId); }
      else if (k === 'p') { stop(); go(worklist?.prevOrderId); }
      return;
    }
    if (e.key === '?' && !isTextTarget(t)) { stop(); setModal({ kind: 'shortcuts' }); return; }
    if (!inBox || mod) return;
    const cell = t instanceof Element ? t.closest<HTMLElement>('[role=gridcell]') : null;
    if (!cell || cell.hasAttribute('data-slot') || idx < 0) return;
    const col = Number(cell.getAttribute('aria-colindex')) - 1;
    const r = rowsInfo[idx]?.r;
    if (t instanceof HTMLInputElement) {                       // the kit's cell editor: it commits on Enter; afterwards go to the next / previous editable row
      if (e.key === 'Enter' && !e.altKey) setTimeout(() => moveEditable(idx, e.shiftKey ? -1 : 1), 0);
      return;
    }
    if (t !== cell) return;
    if (e.key === 'Tab') {                                     // next / previous cell of the same row
      const sib = (e.shiftKey ? cell.previousElementSibling : cell.nextElementSibling) as HTMLElement | null;
      if (sib?.getAttribute('role') === 'gridcell' && !sib.hasAttribute('data-slot')) { stop(); sib.focus(); }
      return;
    }
    if (col !== VALUE_COL && e.key !== ' ') return;
    if (e.key === ' ') {                                       // Space selects a verified result for Alt+A
      stop();
      if (canApprove && r?.status === 'verified') setSelected((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; });
      return;
    }
    if (e.key === 'Enter' && (e.shiftKey || !r || !editable(r))) { stop(); moveEditable(idx, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F2') return;
    if (e.key.length === 1 && !e.altKey) { stop(); if (r && editable(r)) startTyping(cell, e.key); }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const k = (e: KeyboardEvent) => keyRef.current(e);
    const dbl = (e: MouseEvent) => {                           // no edit mode on locked / calculated rows
      const i = rowIdx(e.target), cell = e.target instanceof Element ? e.target.closest('[role=gridcell]') : null;
      const r = i >= 0 ? rowsRef.current[i]?.r : undefined;
      if (cell && Number(cell.getAttribute('aria-colindex')) - 1 === VALUE_COL && r && !editableRef.current(r)) { e.preventDefault(); e.stopPropagation(); }
    };
    const fin = (e: FocusEvent) => { const i = rowIdx(e.target); if (i >= 0) focusedRow.current = i; };
    document.addEventListener('keydown', k, true);
    document.addEventListener('dblclick', dbl, true);
    document.addEventListener('focusin', fin);
    return () => { document.removeEventListener('keydown', k, true); document.removeEventListener('dblclick', dbl, true); document.removeEventListener('focusin', fin); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rowsRef = useRef(rowsInfo); rowsRef.current = rowsInfo;
  const editableRef = useRef(editable); editableRef.current = editable;

  const lookup = async (prefix: string) => { const r = await call(listCommentCodesAction(prefix)); if (!r.ok) throw new Error('lookup failed'); return r.data; };
  const focusedResult = () => results[flat[focusedRow.current]?.id ?? ''];

  return (
    <section aria-label="Result entry">
      <PageHeader title={`Results — ${data.order.registration_no}`} helpKey="lab.results" />
      {banner ? (
        <div role="alert"><Banner tone={banner.kind === 'mfa' ? 'warning' : 'danger'} title={banner.text} {...(banner.kind === 'mfa' ? { action: { label: 'Verify now', onPress: () => void verifyNow() } } : {})} /></div>
      ) : null}
      {canEnter ? (
        <div>
          <Switch label="Downtime back-entry" isSelected={dtOn} onChange={(v) => { setDtOn(v); if (!v) { setDtAt(''); setDtRef(''); setDtErr({}); } }} />
          {dtOn ? (
            <div>
              <label>
                Original time <input type="datetime-local" value={dtAt} onChange={(e) => setDtAt(e.target.value)} aria-invalid={dtErr.at ? true : undefined} aria-describedby={dtErr.at ? 'dt-at-err' : undefined} />
              </label>
              {dtErr.at ? <span id="dt-at-err" className="lims-error">{dtErr.at}</span> : null}
              <TextField label="Paper form serial" name="downtime_ref" maxLength={DOWNTIME_REF_MAX} value={dtRef} onChange={setDtRef} {...(dtErr.ref ? { error: dtErr.ref } : {})} />
            </div>
          ) : null}
        </div>
      ) : null}
      <div ref={box}>
        <EditableGrid label={`Results of ${data.order.registration_no}`} columns={COLS} rows={gridRows} onCellChange={onCellChange} isReadOnly={!canEnter} />
      </div>
      {rowsInfo.map(({ r }) => {
        const slot = slots[r.id];
        if (!slot) return null;
        const prov = provenanceText(r);
        const originSlot = slots[`${ORIGIN_PREFIX}${r.id}`];
        return createPortal(
          <>
            {originSlot ? createPortal(<StatusChip kind="generic" status="instrument" tone="info" label="Instrument" size="sm" />, originSlot, `${ORIGIN_PREFIX}${r.id}`) : null}
            {prov ? <Tooltip content={prov}><span role="note" tabIndex={0} aria-label={`Calculation: ${prov}`} className="lims-chip lims-chip-sm">ƒ</span></Tooltip> : null}
            {editable(r)
              ? <CommentCell key={r.id} defaultValue={r.comment_text ?? ''} defaultCodes={r.comment_codes ?? []} lookupCode={lookup} onChange={(c) => onComment(r.id, c)} />
              : r.comment_text ? <span>{r.comment_text}</span> : null}
          </>,
          slot, r.id,
        );
      })}
      {data.items.map((item) => {
        const at = stepOf(item.results.map((x) => (results[x.id] ?? x).status));
        const next = at >= 0 ? TRACK[at + 1] : undefined;
        return (
          <section key={item.order_item_id} aria-label={`Progress of ${item.test.test_code}`}>
            <StatusStepper steps={TRACK} currentId={TRACK[at]?.id ?? ''} />
            {next ? <p className="lims-description">Next: {next.label}</p> : null}
          </section>
        );
      })}
      <div role="toolbar" aria-label="Result actions">
        {canEnter ? <Button variant="primary" isLoading={busy} onPress={() => void save()}>Save</Button> : null}
        {canEnter && canVerify ? <Button isDisabled={busy} onPress={() => void saveAndVerify(focusedRow.current)}>Save &amp; verify</Button> : null}
        {canApprove ? <Button isDisabled={busy} onPress={() => void approve()}>Approve</Button> : null}
        {canVerify ? <Button variant="ghost" onPress={() => { const r = focusedResult(); if (r?.status === 'verified') setModal({ kind: 'return', id: r.id }); }}>Return</Button> : null}
        {canAmend ? <Button variant="ghost" onPress={() => { const r = focusedResult(); if (r?.status === 'approved') setModal({ kind: 'amend', id: r.id }); }}>Amend</Button> : null}
      </div>

      {history ? <HistoryPanel analyte={history.title} rows={history.rows} onClose={() => setHistory(null)} /> : null}
      {trend ? <TrendDialog analyte={trend.title} unit={trend.unit} data={trend.data} onClose={() => setTrend(null)} /> : null}
      <KeyboardShortcutsDialog isOpen={modal?.kind === 'shortcuts'} onClose={() => setModal(null)} groups={SHORTCUT_GROUPS} />
      {modal?.kind === 'verify' ? <VerifyPrompt rows={modal.rows} analytes={analytes} onCancel={() => { modal.resolve(null); }} onVerify={(a) => modal.resolve(a)} /> : null}
      {modal?.kind === 'return' ? <ReturnDialog reasons={returnReasons} onCancel={() => setModal(null)} onReturn={doReturn} /> : null}
      {modal?.kind === 'amend' && modalRow() ? <AmendDialog result={modalRow()!} analytes={analytes} reasons={amendmentReasons} onCancel={() => setModal(null)} onAmend={doAmend} /> : null}
      {modal?.kind === 'leave' ? (
        <ConfirmDialog title="Unsaved results" body="You have unsaved results. Leave without saving?" confirmLabel="Leave" isOpen onCancel={() => setModal(null)}
          onConfirm={() => { const to = modal.to; setModal(null); router.push(`/lab/orders/${to}/results`); }} />
      ) : null}
    </section>
  );
}

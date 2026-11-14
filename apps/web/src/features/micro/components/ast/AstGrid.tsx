'use client';
// 04-UI-UX §3.3 AST grid (03-APP-FLOW §4.5 steps 4-6; AC-06.1 … AC-06.7 and AC-07.5, UI side). LD-140 (2026-11-13): kit components only (no hex colours, pixel radii or
// inline style objects); one primary button per page ("Save AST" is secondary); every status shows tone, icon and word.
// One row per panel antibiotic, in panel order. The raw value is sent exactly as typed (never parsed here); a suggestion (M13, 300 ms after the blur, changed rows only) is
// only ever shown, and "Use" copies it into the row's fields: Save then sends accept_suggestion:true with the same breakpoint_band_id (AC-07.5) — any later edit of the value,
// the category, the standard or the version makes it a manual entry. Save sends the changed rows only (recordAstResults M12, <= 60 entries per request, a new Idempotency-Key
// per click); per-entry failures stay on their row with the user's input kept; stored rows are committed even when others fail (03-APP-FLOW §6). The categories come from the
// coded set `ast_interpretations` per standard — nothing is hard-coded except the CLSI colistin / polymyxin B restriction to I and R (04 D14, TRD §4.4 step 3).
// The grid never decides anything the server decides: it shows, collects and sends. All text from the API is rendered as text nodes (REQ-SEC-088); nothing is logged.
import './ast.css';
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Inline } from '@lims/ui/components/Inline';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice, failText, newKey, type Fail } from '../common';
import { useCodes } from '../../forms/useCodes';
import { previewAstAction, recordAstAction } from '../../server/astActions';
import { AST_ENTRY_CAP, STANDARDS, type AstMethod, type AstRecordEntry, type AstRecordResult, type AstResultDto, type IsolateDto, type Standard } from '../../server/types';
import { AstRow, NONE, methodLabel, type RowError, type RowHandlers, type Suggestion, type Vm } from './AstRow';
import { RAW_VALUE_MESSAGE, isValidRawValue } from './rawValue';

export interface AstGridProps {
  isolate: IsolateDto;
  /** The tenant default standard (settings.manual_ast_standard); undefined = nothing preselected. */
  defaultStandard?: 'CLSI' | 'EUCAST';
  /** micro.culture.work and a culture state that allows writes; a withdrawn isolate is read-only whatever this says. */
  canWork: boolean;
  /** Called once per save click when at least one entry was stored (the page refreshes: the server owns the data). */
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Alt+A: while `current` is true the grid focuses its first Raw value once the table is shown, then clears it. */
  focusRequest?: { current: boolean };
}

/** First enabled Raw value input of the grid under `root` (Alt+A, 04-UI-UX §3). */
export function focusFirstAstInput(root: ParentNode | null): boolean {
  const el = root?.querySelector<HTMLElement>('table[role="grid"][aria-label^="AST results"] td[data-ast-raw] input:not([disabled])');
  el?.focus();
  return !!el;
}

const DEBOUNCE_MS = 300; // [CONV] 03-APP-FLOW §4.5 step 5
const RESTRICTED = new Set(['colistin', 'polymyxin_b']); // CLSI: I / R only (04 D14)
const RESTRICTED_CODES = new Set(['I', 'R']);
const STANDARD_OPTIONS = STANDARDS.map((s) => ({ value: s, label: s }));
const COLUMNS = ['Antibiotic', 'Method', 'Raw value', 'Suggested', 'Category', 'Source', 'Report'];

// 04-UI-UX §10 copy for the per-entry codes of recordAstResults.
const MSG = {
  needValue: 'Enter the measured value before choosing a category.',
  standard: 'Choose the standard and version for this category.',
  category: "This category isn't allowed for this standard or antibiotic.",
  panel: "This antibiotic isn't in the panel. Tick 'Add to isolate' to record it anyway.",
};

interface Draft { raw?: string; category?: string | null; report?: boolean; add?: boolean }
interface Accepted { band: string; category: string; standard: Standard; version: string }
type Stored = Pick<AstResultDto, 'version'> & Partial<Pick<AstResultDto, 'raw_value' | 'category_code' | 'standard' | 'standard_version' | 'interpretation_source' | 'is_reportable'>>;

const without = <T,>(o: Record<string, T>, k: string): Record<string, T> => {
  if (!(k in o)) return o;
  const { [k]: _gone, ...rest } = o;
  return rest;
};

/** A per-entry failure -> the control it belongs to + the §10 text. Neither the code nor the path is ever shown. */
function rowError(res: AstRecordResult): RowError {
  const code = res.code ?? '';
  const field = /\/entries\/\d+\/([a-z_]+)$/.exec(res.path ?? '')?.[1];
  const target: RowError['target'] = field === 'raw_value' ? 'raw' : field === 'category_code' || field === 'standard' || field === 'standard_version' ? 'category' : 'row';
  if (code === 'micro.ast_value_invalid') return field === 'category_code' ? { target: 'category', text: MSG.needValue, code } : { target: 'raw', text: RAW_VALUE_MESSAGE, code };
  if (code === 'micro.ast_standard_required') return { target: 'category', text: MSG.standard, code };
  if (code === 'micro.ast_category_not_allowed') return { target: 'category', text: MSG.category, code };
  if (code === 'micro.antibiotic_not_in_panel') return { target: 'row', text: MSG.panel, code };
  return { target, text: failText({ ok: false, status: 0, code }), code }; // validation_failed, version_conflict, anything unknown -> §10 / generic
}

export function AstGrid({ isolate, defaultStandard, canWork, onSaved, onDirtyChange, focusRequest }: AstGridProps) {
  const toast = useToast();
  const codes = useCodes('ast_interpretations');
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => {
    if (!codes.loaded || !focusRequest?.current) return;
    focusRequest.current = false;
    focusFirstAstInput(table.current?.parentElement ?? null);
  }, [codes.loaded, focusRequest]);
  const readOnly = !canWork || isolate.status === 'withdrawn';

  const [standard, setStandard] = useState<Standard | undefined>(defaultStandard);
  const [version, setVersion] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [stored, setStored] = useState<Record<string, Stored>>({}); // what a successful save returned (until the page refresh brings the same data)
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, RowError>>({});
  const [askAdd, setAskAdd] = useState<Record<string, boolean>>({});
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [accepted, setAccepted] = useState<Record<string, Accepted>>({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Fail>();

  const base = isolate.ast;
  useEffect(() => setStored((p) => (Object.keys(p).length ? {} : p)), [base]);

  const vms = useMemo<Vm[]>(() => {
    const rows = (base ?? []).map((r, i) => ({ r: (stored[r.antibiotic_code] ? { ...r, ...stored[r.antibiotic_code] } : r) as AstResultDto, i }));
    rows.sort((a, b) => (a.r.panel_sort_order ?? 0) - (b.r.panel_sort_order ?? 0) || a.i - b.i);
    return rows.map(({ r }) => {
      const d = drafts[r.antibiotic_code] ?? {};
      const raw = d.raw ?? r.raw_value ?? '';
      const category = d.category === undefined ? r.category_code : (d.category ?? undefined);
      const report = d.report ?? r.is_reportable;
      const rawEdited = d.raw !== undefined && d.raw.trim() !== '' && d.raw !== (r.raw_value ?? '');
      const catEdited = typeof d.category === 'string' && d.category !== r.category_code;
      const repEdited = d.report !== undefined && d.report !== r.is_reportable;
      return { row: r, code: r.antibiotic_code, raw, category, report, rawEdited, catEdited, repEdited, dirty: rawEdited || catEdited || repEdited, valid: isValidRawValue(r.method, raw) };
    });
  }, [base, stored, drafts]);
  const dirty = vms.some((v) => v.dirty);

  // Latest values for timers and key handlers (they outlive a render).
  const latest = useRef({ vms, standard, version, accepted, askAdd, drafts, readOnly, codes: codes.rows });
  latest.current = { vms, standard, version, accepted, askAdd, drafts, readOnly, codes: codes.rows };

  // ---- unsaved-changes tracking: the page guards the tab (ConfirmDialog), the browser guards reload / close.
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current !== dirty) {
      reported.current = dirty;
      onDirtyChange?.(dirty);
    }
  }, [dirty, onDirtyChange]);
  useEffect(() => () => { if (reported.current) onDirtyChange?.(false); }, [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: Event) => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---- categories per standard (stable arrays: the memoised rows compare them by identity)
  const optionSets = useMemo(() => {
    const all = standard
      ? codes.rows.filter((c) => c.is_active && c.standard === standard).sort((a, b) => a.sort_order - b.sort_order).map((c) => ({ value: c.code, label: `${c.code} — ${c.display}` }))
      : [];
    return { all, restricted: all.filter((o) => RESTRICTED_CODES.has(o.value)) };
  }, [codes.rows, standard]);
  const allowed = (std: Standard, abx: string, category: string) => {
    if (std === 'CLSI' && RESTRICTED.has(abx) && !RESTRICTED_CODES.has(category)) return false;
    return latest.current.codes.some((c) => c.is_active && c.standard === std && c.code === category);
  };

  const changeStandard = (next: Standard) => {
    if (next === latest.current.standard) return;
    latest.current.standard = next;
    setStandard(next);
    // A category the new standard does not have is cleared (never compare across standards — 06-GLOSSARY); one it has is kept.
    const clear = latest.current.vms.filter((v) => v.category && !allowed(next, v.code, v.category)).map((v) => v.code);
    if (clear.length) setDrafts((p) => ({ ...p, ...Object.fromEntries(clear.map((c) => [c, { ...p[c], category: null }])) }));
    setAccepted((p) => Object.fromEntries(Object.entries(p).filter(([, a]) => a.standard === next)));
  };

  // ---- edits
  const quiet = (code: string) => {
    setErrors((p) => without(p, code));
    setFail(undefined);
  };
  const edit = (code: string, patch: Draft) => {
    setDrafts((p) => ({ ...p, [code]: { ...p[code], ...patch } }));
    quiet(code);
  };

  // ---- debounced preview (M13)
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const asked = useRef<Record<string, string>>({});
  const seq = useRef<Record<string, number>>({});
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);
  const forget = (code: string) => {
    seq.current[code] = (seq.current[code] ?? 0) + 1; // an answer for the old value must not show
    delete asked.current[code];
    pending.current.delete(code);
    setSuggestions((p) => without(p, code));
    setAccepted((p) => without(p, code));
  };
  const flush = async () => {
    const sent: Record<string, { n: number; raw: string }> = {};
    const entries: { antibiotic_code: string; method: AstMethod; raw_value: string }[] = [];
    for (const code of pending.current) {
      const v = latest.current.vms.find((x) => x.code === code);
      if (!v || !v.rawEdited || !v.valid) continue;
      seq.current[code] = (seq.current[code] ?? 0) + 1;
      sent[code] = { n: seq.current[code]!, raw: v.raw };
      entries.push({ antibiotic_code: code, method: v.row.method, raw_value: v.raw });
    }
    pending.current.clear();
    if (!entries.length) return;
    let res;
    try {
      res = await previewAstAction(isolate.id, entries.slice(0, AST_ENTRY_CAP));
    } catch {
      res = undefined;
    }
    if (!alive.current) return;
    if (!res?.ok) { for (const c of Object.keys(sent)) delete asked.current[c]; return; } // a failed preview shows nothing; the next blur asks again
    for (const r of res.data) {
      const code = r.antibiotic_code;
      const s = sent[code];
      if (!s || seq.current[code] !== s.n) continue; // the last response wins
      setSuggestions((p) => (r.suggestion ? { ...p, [code]: { ...r.suggestion, raw: s.raw } } : without(p, code)));
    }
  };
  const queuePreview = (code: string) => {
    const v = latest.current.vms.find((x) => x.code === code);
    if (!v || latest.current.readOnly || !v.rawEdited || !v.valid || asked.current[code] === v.raw) return;
    asked.current[code] = v.raw;
    pending.current.add(code);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
  };

  const use = (code: string, s: Suggestion) => {
    changeStandard(s.standard);
    edit(code, { category: s.category_code });
    setAccepted((p) => ({ ...p, [code]: { band: s.breakpoint_band_id, category: s.category_code, standard: s.standard, version: s.standard_version } }));
    if (latest.current.version.trim() === '') setVersion(s.standard_version);
  };

  // Row handlers: stable identities (the memoised rows compare them); they always run the latest code through the ref.
  const handlers = useRef<RowHandlers>(undefined as never);
  handlers.current = {
    raw: (code, raw) => { forget(code); edit(code, { raw }); },
    category: (code, category) => edit(code, { category }),
    report: (code, report) => edit(code, { report }),
    add: (code, add) => edit(code, { add }),
    use,
  };
  const on = useMemo<RowHandlers>(() => ({
    raw: (c, v) => handlers.current.raw(c, v),
    category: (c, v) => handlers.current.category(c, v),
    report: (c, v) => handlers.current.report(c, v),
    add: (c, v) => handlers.current.add(c, v),
    use: (c, s) => handlers.current.use(c, s),
  }), []);

  // ---- save (M12)
  const inflight = useRef(false);
  const toEntry = (v: Vm): AstRecordEntry => {
    const { standard: std, version: ver, accepted: acc, askAdd: ask, drafts: d } = latest.current;
    const e: AstRecordEntry = { antibiotic_code: v.code, method: v.row.method, version: v.row.version };
    if (v.rawEdited) e.raw_value = v.raw;
    if (v.catEdited && v.category) {
      e.category_code = v.category;
      if (std) e.standard = std;
      if (ver.trim()) e.standard_version = ver.trim();
      const a = acc[v.code];
      // AC-07.5 / 03-APP-FLOW §4.5 step 5: "Use" keeps the suggestion's version as a per-row override (04-UI-UX §3.3), even when the header version differs.
      if (a && a.category === v.category && a.standard === std) { e.standard = a.standard; e.standard_version = a.version; e.accept_suggestion = true; e.breakpoint_band_id = a.band; }
    }
    if (v.repEdited) e.is_reportable = v.report;
    if (ask[v.code] && d[v.code]?.add) e.add_to_isolate = true;
    return e;
  };
  /** Applies one response; returns how many entries were stored. */
  const apply = (part: AstRecordEntry[], results: AstRecordResult[]): number => {
    let ok = 0;
    for (const res of results) {
      const code = res.antibiotic_code;
      const entry = part.find((p) => p.antibiotic_code === code);
      if (!entry || !latest.current.vms.some((v) => v.code === code)) continue;
      if (res.outcome === 'ok') {
        ok += 1;
        const r = res.ast_result;
        const raw = r?.raw_value ?? entry.raw_value;
        const cat = r?.category_code ?? entry.category_code;
        setStored((p) => ({
          ...p,
          [code]: {
            version: r?.version ?? (entry.version ?? 0) + 1,
            ...(raw !== undefined ? { raw_value: raw } : {}),
            ...(cat !== undefined ? { category_code: cat } : {}),
            ...(r?.standard ? { standard: r.standard } : {}),
            ...(r?.standard_version ? { standard_version: r.standard_version } : {}),
            ...(r?.interpretation_source ? { interpretation_source: r.interpretation_source } : {}),
            ...(r ? { is_reportable: r.is_reportable } : entry.is_reportable !== undefined ? { is_reportable: entry.is_reportable } : {}),
          },
        }));
        setDrafts((p) => without(p, code));
        setTouched((p) => without(p, code));
        setAskAdd((p) => without(p, code));
        quiet(code);
        forget(code);
      } else {
        const err = rowError(res);
        setErrors((p) => ({ ...p, [code]: err }));
        if (err.code === 'micro.antibiotic_not_in_panel') setAskAdd((p) => ({ ...p, [code]: true }));
      }
    }
    return ok;
  };
  const save = async () => {
    if (inflight.current || latest.current.readOnly) return;
    const rows = latest.current.vms.filter((v) => v.dirty);
    if (!rows.length) return;
    const invalid = rows.filter((v) => !v.valid);
    if (invalid.length) { // the grammar error shows on the row; nothing is sent
      setTouched((p) => ({ ...p, ...Object.fromEntries(invalid.map((v) => [v.code, true])) }));
      return;
    }
    const entries = rows.map(toEntry);
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    let done = 0;
    try {
      for (let i = 0; i < entries.length; i += AST_ENTRY_CAP) {
        const part = entries.slice(i, i + AST_ENTRY_CAP);
        const r = await recordAstAction(isolate.id, part, newKey()); // one key per request: a second click is a new attempt
        if (!alive.current) return;
        if (!r.ok) { setFail(r); break; }
        done += apply(part, r.data);
      }
    } catch {
      if (alive.current) setFail({ ok: false, status: 0, code: 'common.internal' });
    } finally {
      inflight.current = false;
      if (alive.current) setBusy(false);
    }
    if (done > 0 && alive.current) {
      toast.show({ tone: 'success', title: done === 1 ? 'AST result saved' : `${done} AST results saved` });
      onSaved();
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // ---- keyboard (04-UI-UX §3.3): Enter in Raw value -> next row's Raw value; Ctrl+Enter saves the grid; Tab follows reading order (nothing here changes it).
  const rawCell = (t: HTMLElement) => (t.tagName === 'INPUT' ? t.closest<HTMLElement>('td[data-ast-raw]') : null);
  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      void saveRef.current();
      return;
    }
    const cell = rawCell(e.target as HTMLElement);
    if (!cell || latest.current.readOnly) return;
    e.preventDefault();
    queuePreview(cell.getAttribute('data-ast-raw')!);
    const all = [...e.currentTarget.querySelectorAll<HTMLInputElement>('td[data-ast-raw] input')];
    all[all.indexOf(e.target as HTMLInputElement) + 1]?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLTableElement>) => {
    const code = rawCell(e.target as HTMLElement)?.getAttribute('data-ast-raw');
    if (!code) return;
    setTouched((p) => (p[code] ? p : { ...p, [code]: true }));
    queuePreview(code);
  };

  if (!codes.loaded) return <LoadingSkeleton variant="table" rows={3} />;

  const panel = isolate.ast_panel;
  const method = isolate.ast_method ? methodLabel(isolate.ast_method) : undefined;
  return (
    <Stack gap={2}>
      <FailNotice fail={fail} />
      <FailNotice fail={codes.fail} />
      <p>
        {panel ? `${panel.display} · version ${panel.version_no}` : 'No panel'}
        {method ? ` · Method: ${method} ` : ''}
      </p>
      <Inline gap={3}>
        <Select<Standard>
          label="Standard"
          name="standard"
          placeholder="Choose standard"
          options={STANDARD_OPTIONS}
          value={standard ?? (NONE as Standard)}
          {...(readOnly ? { isReadOnly: true } : {})}
          onChange={changeStandard}
        />
        <TextField label="Version" name="standard_version" maxLength={32} value={version} {...(readOnly ? { isReadOnly: true } : {})} onChange={setVersion} />
      </Inline>
      <table ref={table} role="grid" aria-label={`AST results for isolate ${isolate.isolate_seq}`} className="lims-ast-grid lims-table lims-table-compact" onKeyDownCapture={onKeyDown} onBlur={onBlur}>
        <thead>
          <tr role="row">
            {COLUMNS.map((h) => (
              <th key={h} role="columnheader" scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {vms.map((v) => (
            <AstRow
              key={v.code}
              vm={v}
              options={standard === 'CLSI' && RESTRICTED.has(v.code) ? optionSets.restricted : optionSets.all}
              error={errors[v.code]}
              suggestion={suggestions[v.code]}
              touched={!!touched[v.code]}
              askAdd={!!askAdd[v.code]}
              add={!!drafts[v.code]?.add}
              readOnly={readOnly}
              on={on}
            />
          ))}
        </tbody>
      </table>
      {!readOnly ? (
        <Inline gap={2}>
          <Button variant="secondary" shortcut="Ctrl+Enter" isDisabled={!dirty} isLoading={busy} onPress={() => void save()}>
            Save AST
          </Button>
        </Inline>
      ) : null}
    </Stack>
  );
}

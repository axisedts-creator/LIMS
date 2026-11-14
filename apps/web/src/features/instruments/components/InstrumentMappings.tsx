'use client';
// SCR-08 Mappings (04-UI-UX §3; data owned by C3 — X4). Observed codes (E32) for every reader; the C3 Mappings panel, editor
// and "Copy from instrument…" only with catalog.instrument_code_map.manage (D-39) — the gate is re-checked here even if a
// caller passes maps. All writes go through server actions (the BFF adds the JWT; this file never sees it).
// [CONV] plain <table>s instead of DataTable: the panels carry per-row buttons and the copy outcome must be a real table.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DateText } from '@lims/ui/components/DateText';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { KeyValueListEditor, type KeyValueRow } from '@lims/ui/components/KeyValueListEditor';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import {
  createInstrumentCodeMapAction, getTestRefAction, listInstrumentCodeMapsAction, listUnitRefsAction, searchTestsAction,
  updateInstrumentCodeMapAction, upsertInstrumentCodeMapsAction,
} from '../server/actions';
import {
  BULK_MAX, CODE_MAP_MANAGE, codeMapProblems, isFactor, parseFlagMap, rowBody,
  type CodeMapPatch, type CodeMapResult, type Direction, type InstrumentCodeMap, type ObservedCode, type TestRef, type UnitRef, type Unsettable,
} from '../server/codeMaps';
import type { ActionResult, FieldProblemDto, Instrument, InstrumentSummary } from '../server/types';

const MFA = 'Confirm with your authenticator to continue';
const DUP = 'This code is already mapped for this instrument.';
const NONE = '__none__';
const CLASS: Record<string, string> = { patient: 'Patient', qc: 'QC', calibrator: 'Calibrator' };
const DIRECTION: Record<string, string> = { inbound: 'Inbound', outbound: 'Outbound', both: 'Both' };
const DIRECTION_OPTIONS = Object.entries(DIRECTION).map(([value, label]) => ({ value: value as Direction, label }));
// [CONV] client messages (spec gives only the duplicate text)
const MSG: Record<string, string> = {
  '/instrument_code': 'Enter the instrument code (1–64 characters).',
  '/test_id': 'Choose a test.',
  '/analyte_id': 'Choose an analyte of this test.',
  '/unit_from_raw': 'Enter all three unit fields, or none.',
  '/unit_to_code': 'Enter all three unit fields, or none.',
  '/unit_factor': 'Factor must be greater than 0, with up to 6 decimals.',
  '/flag_map': 'Flag map: up to 20 rows, each flag 1–16 and code 1–64 characters, no repeated flag.',
};

type TestOpt = { id: string; code: string; name: string };
type Fail = Extract<ActionResult<unknown>, { ok: false }>;
const flagCount = (t?: string) => (t ? Object.keys(parseFlagMap(t) ?? {}).length : 0);
const flagRows = (t?: string): KeyValueRow[] => Object.entries(parseFlagMap(t) ?? {}).map(([key, value]) => ({ key, value }));
const flagText = (rows: readonly KeyValueRow[]) => (rows.length ? JSON.stringify(Object.fromEntries(rows.map((r) => [r.key, r.value]))) : undefined);
const unitText = (m: InstrumentCodeMap) => (m.unit_from_raw && m.unit_to_code && m.unit_factor ? `${m.unit_from_raw} → ${m.unit_to_code} × ${m.unit_factor}` : '—');
/** Cell with a trailing space: row text reads as separate words (row names, copy/paste). */
const Td = ({ children }: { children: ReactNode }) => <td>{children} </td>;
const failText = (what: string, code: string) => `Could not ${what} (${code})`;

/** Idempotency-Key kept across the step-up retry only; any other answer starts a new request (02-CONVENTIONS §4.5). */
function useIdemKey() {
  const k = useRef<string | undefined>(undefined);
  return { get: () => (k.current ??= crypto.randomUUID()), settle: (code?: string) => { if (code !== 'auth.mfa_required') k.current = undefined; } };
}

function MfaBanner({ onContinue }: { onContinue: () => void }) {
  return (
    <div role="alert">
      <Banner tone="warning" title={MFA} action={{ label: 'Continue', onPress: onContinue }} />
    </div>
  );
}
const ErrorBanner = ({ text }: { text: string }) => (
  <div role="alert">
    <Banner tone="danger" title={text} />
  </div>
);

export interface InstrumentMappingsProps {
  instrument: Pick<Instrument, 'id' | 'instrument_code' | 'display_name'>;
  observed: readonly ObservedCode[];
  maps?: readonly InstrumentCodeMap[];
  tests?: Readonly<Record<string, TestRef>>;
  instruments?: readonly Pick<InstrumentSummary, 'id' | 'instrument_code' | 'display_name'>[];
  permissions: readonly string[];
}

type EditorState = { mode: 'create'; code: string } | { mode: 'edit'; map: InstrumentCodeMap };

export function InstrumentMappings({ instrument, observed, maps = [], tests = {}, instruments = [], permissions }: InstrumentMappingsProps) {
  const manage = permissions.includes(CODE_MAP_MANAGE);
  const router = useRouter();
  const [unmappedOnly, setUnmappedOnly] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deactivating, setDeactivating] = useState<InstrumentCodeMap | null>(null);
  const [copying, setCopying] = useState(false);
  const rows = unmappedOnly ? observed.filter((o) => o.last_mapping_status !== 'mapped') : observed;
  const testName = (m: InstrumentCodeMap) => tests[m.test_id]?.name ?? m.test_id;
  const analyteName = (m: InstrumentCodeMap) => tests[m.test_id]?.analytes.find((a) => a.id === m.analyte_id)?.name ?? m.analyte_id;

  return (
    <section aria-label="Instrument mappings" className="lims-mappings">
      <PageHeader
        title={`Mappings — ${instrument.instrument_code}`}
        helpKey="instruments.instruments"
        breadcrumbs={[{ label: 'Instruments', href: '/instruments/instruments' }, { label: instrument.instrument_code, href: `/instruments/instruments/${instrument.id}` }, { label: 'Mappings' }]}
        actions={manage ? (
          <>
            <Button variant="primary" onPress={() => setEditor({ mode: 'create', code: '' })}>Add mapping</Button>
            <Button onPress={() => setCopying(true)}>Copy from instrument…</Button>
          </>
        ) : null}
      />
      <div className="lims-grid">
        <section aria-labelledby="obs-h" className={manage ? 'lims-col-5' : 'lims-col-12'}>
          <h2 id="obs-h">Observed codes</h2>
          <Switch label="Unmapped only" isSelected={unmappedOnly} onChange={setUnmappedOnly} />
          {observed.length === 0 ? (
            <EmptyState title="No codes seen yet. Codes appear here after the instrument sends results in commissioning." />
          ) : (
            <table className="lims-table">
              <caption className="lims-visually-hidden">Observed codes</caption>
              <thead>
                <tr><th scope="col">Code</th><th scope="col">Class</th><th scope="col">Seen count</th><th scope="col">Last seen</th><th scope="col">Mapping status</th>{manage ? <th scope="col"><VisuallyHidden>Actions</VisuallyHidden></th> : null}</tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={`${o.record_class}:${o.instrument_analyte_code}`}>
                    <Td>{o.instrument_analyte_code}</Td>
                    <Td>{CLASS[o.record_class] ?? o.record_class}</Td>
                    <Td>{o.seen_count}</Td>
                    <Td><DateText value={o.last_seen_at as never} withTime /></Td>
                    <Td>{o.last_mapping_status === 'mapped' ? 'Mapped' : 'Unmapped'}</Td>
                    {manage ? (
                      <td>
                        <Button size="sm" variant="ghost" onPress={() => setEditor({ mode: 'create', code: o.instrument_analyte_code })}>
                          Map…<VisuallyHidden>{` ${o.instrument_analyte_code}`}</VisuallyHidden>
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {manage ? (
          <section aria-labelledby="maps-h" className="lims-col-7">
            <h2 id="maps-h">Mappings</h2>
            {maps.length === 0 ? (
              <EmptyState title="No mappings yet." />
            ) : (
              <table className="lims-table">
                <caption className="lims-visually-hidden">Mappings</caption>
                <thead>
                  <tr><th scope="col">Direction</th><th scope="col">Instrument code</th><th scope="col">Test</th><th scope="col">Analyte</th><th scope="col">Unit conversion</th><th scope="col">Flag map count</th><th scope="col">Active</th><th scope="col"><VisuallyHidden>Actions</VisuallyHidden></th></tr>
                </thead>
                <tbody>
                  {maps.map((m) => (
                    <tr key={m.id}>
                      <Td>{DIRECTION[m.direction] ?? m.direction}</Td>
                      <Td>{m.instrument_code}</Td>
                      <Td>{testName(m)}</Td>
                      <Td>{analyteName(m)}</Td>
                      <Td>{unitText(m)}</Td>
                      <Td>{flagCount(m.flag_map)}</Td>
                      <Td>{m.is_active ? 'Active' : 'Inactive'}</Td>
                      <td>
                        <Button size="sm" variant="ghost" onPress={() => setEditor({ mode: 'edit', map: m })}>Edit<VisuallyHidden>{` ${m.instrument_code}`}</VisuallyHidden></Button>
                        {m.is_active ? <Button size="sm" variant="ghost" onPress={() => setDeactivating(m)}>Deactivate<VisuallyHidden>{` ${m.instrument_code}`}</VisuallyHidden></Button> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ) : (
          <section aria-label="Mappings" className="lims-col-12">
            <EmptyState title="Mappings are visible to users who can manage them." />
          </section>
        )}
      </div>

      {manage && editor ? (
        <MappingEditor
          key={editor.mode === 'edit' ? editor.map.id : `new:${editor.code}`}
          state={editor}
          instrumentId={instrument.id}
          tests={tests}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); router.refresh(); }}
        />
      ) : null}
      {manage && deactivating ? <DeactivateDialog map={deactivating} onClose={() => setDeactivating(null)} onDone={() => { setDeactivating(null); router.refresh(); }} /> : null}
      {manage && copying ? <CopyDialog instrumentId={instrument.id} sources={instruments.filter((i) => i.id !== instrument.id)} onClose={() => setCopying(false)} onCopied={() => router.refresh()} /> : null}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── editor (Drawer md)
function MappingEditor({ state, instrumentId, tests, onClose, onSaved }: { state: EditorState; instrumentId: string; tests: Readonly<Record<string, TestRef>>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const edit = state.mode === 'edit';
  const orig = edit ? state.map : undefined;
  const [direction, setDirection] = useState<Direction>(orig?.direction ?? 'both');
  const [code, setCode] = useState(orig?.instrument_code ?? (state.mode === 'create' ? state.code : ''));
  const [test, setTest] = useState<TestOpt | undefined>(orig ? { id: orig.test_id, code: tests[orig.test_id]?.code ?? '', name: tests[orig.test_id]?.name ?? orig.test_id } : undefined);
  const [analytes, setAnalytes] = useState<TestRef['analytes']>(orig ? (tests[orig.test_id]?.analytes ?? []) : []);
  const [analyteId, setAnalyteId] = useState<string | undefined>(orig?.analyte_id);
  const [from, setFrom] = useState(orig?.unit_from_raw ?? '');
  const [to, setTo] = useState(orig?.unit_to_code ?? NONE);
  const [factor, setFactor] = useState<string | undefined>(orig?.unit_factor);
  const [flags, setFlags] = useState<KeyValueRow[]>(() => flagRows(orig?.flag_map));
  const [units, setUnits] = useState<UnitRef[]>([]);
  const [show, setShow] = useState(false);
  const [serverErr, setServerErr] = useState<Record<string, string>>({});
  const [mfa, setMfa] = useState(false);
  const [alert, setAlert] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const key = useIdemKey();

  useEffect(() => {
    let live = true;
    void listUnitRefsAction().then((r) => { if (live && r.ok) setUnits(r.data); });
    return () => { live = false; };
  }, []);

  const pickTest = (t: TestOpt | undefined) => {
    setTest(t);
    setAnalyteId(undefined);
    setAnalytes([]);
    setServerErr(({ '/test_id': _a, '/analyte_id': _b, ...r }) => r);
    if (t) void getTestRefAction(t.id).then((r) => { if (r.ok) setAnalytes(r.data.analytes); });
  };

  const fields = () => ({
    direction, instrument_code: code, test_id: test?.id, analyte_id: analyteId,
    ...(from ? { unit_from_raw: from } : {}), ...(to !== NONE ? { unit_to_code: to } : {}), ...(factor ? { unit_factor: factor } : {}),
    ...(flags.length ? { flag_map: flagText(flags) } : {}),
  });
  const problems = () => {
    const p = new Set(codeMapProblems({ instrument_id: instrumentId, ...fields() }, true));
    if (analyteId && analytes.length && !analytes.some((a) => a.id === analyteId)) p.add('/analyte_id');
    if (new Set(flags.map((f) => f.key)).size !== flags.length) p.add('/flag_map');
    return p;
  };
  const clientErr = show ? problems() : new Set<string>();
  const err = (ptr: string) => {
    const m = serverErr[ptr] ?? (clientErr.has(ptr) ? (ptr === '/unit_factor' && factor && !isFactor(factor) ? MSG[ptr] : ptr === '/unit_factor' ? MSG['/unit_from_raw'] : MSG[ptr]) : undefined);
    return m ? { error: m } : {};
  };
  const clear = (...ptrs: string[]) => setServerErr((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !ptrs.includes(k))));

  /** #94 body: changed mutable keys only; an emptied unit trio / flag map becomes unset[]. */
  const patchOf = (): CodeMapPatch => {
    const f = fields() as Record<string, string | undefined>;
    const p: CodeMapPatch = {};
    const unset: Unsettable[] = [];
    for (const k of ['unit_from_raw', 'unit_to_code', 'unit_factor'] as const) {
      if (f[k] === undefined) { if (orig![k] !== undefined) unset.push(k); }
      else if (f[k] !== orig![k]) p[k] = f[k];
    }
    const was = orig!.flag_map ? flagText(flagRows(orig!.flag_map)) : undefined;
    if (f['flag_map'] === undefined) { if (orig!.flag_map !== undefined) unset.push('flag_map'); }
    else if (f['flag_map'] !== was) p.flag_map = f['flag_map'];
    return unset.length ? { ...p, unset } : p;
  };

  const handle = (r: Fail) => {
    key.settle(r.code);
    if (r.code === 'auth.mfa_required') { setMfa(true); return; }
    const known: Record<string, string> = {};
    const loose: string[] = [];
    for (const e of (r.errors ?? []) as FieldProblemDto[]) {
      const msg = e.message ?? e.code ?? r.code;
      if (e.path && e.path in MSG) known[e.path] ??= msg;
      else loose.push(msg);
    }
    if (r.code === 'catalog.code_duplicate') known['/instrument_code'] = DUP;
    setServerErr(known);
    setAlert(loose.length ? loose : Object.keys(known).length ? [] : [failText('save the mapping', r.code)]);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (inFlight.current) return;
    setShow(true);
    setMfa(false);
    setAlert([]);
    if (problems().size) return;
    let call: () => Promise<ActionResult<{ version: number }>>;
    if (edit) {
      const patch = patchOf();
      if (!Object.keys(patch).length) { toast.show({ tone: 'info', title: 'No changes to save.' }); return; }
      call = () => updateInstrumentCodeMapAction(orig!.id, orig!.version, patch);
    } else {
      const body = { instrument_id: instrumentId, ...fields() } as Parameters<typeof createInstrumentCodeMapAction>[0];
      call = () => createInstrumentCodeMapAction(body, key.get());
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await call();
      if (r.ok) {
        key.settle();
        toast.show({ tone: 'success', title: 'Mapping saved.' });
        onSaved();
      } else handle(r);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const analyteOptions = analytes.map((a) => ({ value: a.id, label: a.name }));
  if (analyteId && !analyteOptions.some((o) => o.value === analyteId)) analyteOptions.push({ value: analyteId, label: analyteId });
  const unitOptions = [{ value: NONE, label: '— None' }, ...units.map((u) => ({ value: u.code, label: u.display }))];
  if (to !== NONE && !unitOptions.some((o) => o.value === to)) unitOptions.push({ value: to, label: to });

  return (
    <Drawer title={edit ? 'Edit mapping' : 'New mapping'} isOpen onClose={onClose} width="md">
      <form noValidate onSubmit={(e) => void submit(e)} className="lims-form">
        {mfa ? <MfaBanner onContinue={() => void submit()} /> : null}
        {alert.length ? <ErrorBanner text={alert.join(' ')} /> : null}
        <RadioGroup<Direction> label="Direction" name="direction" options={DIRECTION_OPTIONS} orientation="horizontal" value={direction} onChange={setDirection} isRequired {...(edit ? { isDisabled: true } : {})} />
        <TextField label="Instrument code" name="instrument_code" maxLength={64} value={code} onChange={(v) => { setCode(v); clear('/instrument_code'); }} isRequired {...(edit ? { isReadOnly: true } : {})} {...err('/instrument_code')} />
        <Combobox<TestOpt>
          label="Test"
          name="test_id"
          isRequired
          {...(edit ? { isDisabled: true } : {})}
          {...(test ? { value: test } : {})}
          onChange={pickTest}
          loadOptions={async (q) => { const r = await searchTestsAction(q); return r.ok ? r.data : []; }}
          getKey={(t) => t.id}
          renderOption={(t) => (t.code ? `${t.name} (${t.code})` : t.name)}
          renderValue={(t) => t.name}
          {...err('/test_id')}
        />
        <Select<string> label="Analyte" name="analyte_id" options={analyteOptions} isRequired {...(analyteId ? { value: analyteId } : {})} onChange={(v) => { setAnalyteId(v); clear('/analyte_id'); }} {...(edit || !test ? { isDisabled: true } : {})} {...err('/analyte_id')} />
        <TextField label="Unit from (instrument)" name="unit_from_raw" maxLength={32} value={from} onChange={(v) => { setFrom(v); clear('/unit_from_raw'); }} {...err('/unit_from_raw')} />
        <Select<string> label="Unit to" name="unit_to_code" options={unitOptions} value={to} onChange={(v) => { setTo(v); clear('/unit_to_code'); }} {...err('/unit_to_code')} />
        <DecimalField label="Factor" name="unit_factor" decimals={6} {...(factor !== undefined ? { value: factor } : {})} onChange={(v) => { setFactor(v); clear('/unit_factor'); }} {...err('/unit_factor')} />
        <KeyValueListEditor label="Flag map" name="flag_map" value={flags} onChange={(v) => { setFlags(v); clear('/flag_map'); }} maxRows={20} keyMaxLength={16} valueMaxLength={64} keyLabel="Flag" valueLabel="Code" {...err('/flag_map')} />
        <Button type="submit" variant="primary" isLoading={busy}>Save</Button>
      </form>
    </Drawer>
  );
}

// ───────────────────────────────────────────────────────────────────────────── deactivate (#94 {is_active:false})
function DeactivateDialog({ map, onClose, onDone }: { map: InstrumentCodeMap; onClose: () => void; onDone: () => void }) {
  const [fail, setFail] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFail(null);
    try {
      const r = await updateInstrumentCodeMapAction(map.id, map.version, { is_active: false });
      if (r.ok) onDone();
      else setFail(r.code);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <ConfirmDialog
      title="Deactivate mapping?"
      confirmLabel="Deactivate"
      tone="danger"
      isOpen
      onCancel={onClose}
      onConfirm={run}
      body={
        <>
          {fail === 'auth.mfa_required' ? <MfaBanner onContinue={() => void run()} /> : fail ? <ErrorBanner text={failText('deactivate the mapping', fail)} /> : null}
          <p>{`Code ${map.instrument_code} stops mapping results. To change the code, analyte or direction, deactivate and add a new mapping.`}</p>
        </>
      }
    />
  );
}

// ───────────────────────────────────────────────────────────────────────────── copy (#92 source read → #95 bulk upsert)
function CopyDialog({ instrumentId, sources, onClose, onCopied }: { instrumentId: string; sources: readonly Pick<InstrumentSummary, 'id' | 'instrument_code' | 'display_name'>[]; onClose: () => void; onCopied: () => void }) {
  const [source, setSource] = useState<string>();
  const [rows, setRows] = useState<InstrumentCodeMap[] | null>(null);
  const [results, setResults] = useState<CodeMapResult[] | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const key = useIdemKey();

  const pick = (id: string) => {
    setSource(id);
    setRows(null);
    setResults(null);
    setFail(null);
    key.settle();
    void listInstrumentCodeMapsAction(id).then((r) => {
      if (r.ok) setRows(r.data.filter((m) => m.is_active));
      else setFail(r.code);
    });
  };
  const copy = async () => {
    if (inFlight.current || !rows?.length) return;
    inFlight.current = true;
    setBusy(true);
    setFail(null);
    try {
      const r = await upsertInstrumentCodeMapsAction(instrumentId, rows.slice(0, BULK_MAX).map((m) => rowBody(m as unknown as Record<string, unknown>)), key.get());
      if (r.ok) {
        key.settle();
        setResults(r.data.results);
        onCopied();
      } else {
        key.settle(r.code);
        setFail(r.code);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog title="Copy from instrument" isOpen onClose={onClose} size="lg">
      {fail === 'auth.mfa_required' ? <MfaBanner onContinue={() => void copy()} /> : fail ? <ErrorBanner text={failText('copy the mappings', fail)} /> : null}
      <Select<string> label="Source instrument" name="source_instrument" options={sources.map((s) => ({ value: s.id, label: `${s.instrument_code} — ${s.display_name}` }))} {...(source ? { value: source } : {})} onChange={pick} />
      {rows ? <p>{rows.length > BULK_MAX ? `${rows.length} active mappings; the first ${BULK_MAX} are copied.` : `${rows.length} active mappings to copy.`}</p> : null}
      {results ? (
        <table className="lims-table">
          <caption>Copy result</caption>
          <thead><tr><th scope="col">Instrument code</th><th scope="col">Direction</th><th scope="col">Outcome</th><th scope="col">Error</th></tr></thead>
          <tbody>
            {results.map((x, i) => (
              <tr key={i}><Td>{x.instrument_code}</Td><Td>{DIRECTION[x.direction] ?? x.direction}</Td><Td>{x.outcome}</Td><Td>{x.error_code ?? ''}</Td></tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <Button variant="primary" isDisabled={!rows?.length || !!results} isLoading={busy} onPress={() => void copy()}>Copy</Button>
    </Dialog>
  );
}

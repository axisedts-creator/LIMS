'use client';
// SCR-06 Instrument form (04-UI-UX §3): create in a Dialog (SCR-05), edit on the SCR-07 Configuration tab.
// Schema-driven: client validation = forms/instrument.ts (same rules as the BFF), server errors[] are mapped by JSON Pointer.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { fieldErrorsByPointer } from '../forms/errors';
import { ASTM_OPTIONS, HL7_OPTIONS, instrumentBody, validateInstrument, type InstrumentBody } from '../forms/instrument';
import { BAUD_RATES, DATA_BITS, FILE_TYPES, PARITIES, STOP_BITS, TRANSPORT_KINDS_BY_PROTOCOL, type Protocol, type TransportKind } from '../forms/transport';
import { createInstrumentAction, updateInstrumentAction } from '../server/actions';
import type { AgentSummary, Driver, Instrument } from '../server/types';
import { PROTOCOL_OPTIONS, driverStatusLabel, hasPerm } from './labels';

type Obj = Record<string, unknown>;
type AgentOption = Pick<AgentSummary, 'id' | 'agent_code' | 'display_name' | 'status'>;

const KIND_LABEL: Record<TransportKind, string> = { serial: 'Serial', tcp_client: 'TCP client', tcp_server: 'TCP server', file_drop: 'Folder' };
const FILE_TYPE_LABEL: Record<(typeof FILE_TYPES)[number], string> = { pdf: 'PDF', png: 'PNG', jpg: 'JPEG' };
const MANAGE = 'instruments.instrument.manage';
const nz = (v: unknown) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
const nameOf = (ptr: string) => ptr.slice(1).replace(/\//g, '.');
const on = <T extends object>(c: unknown, o: T): Partial<T> => (c ? o : {});
const clean = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

const KIND_DEFAULTS: Record<TransportKind, Obj> = {
  serial: { dtr: true, rts: true },
  tcp_client: { connect_timeout_s: 10, reconnect_max_backoff_s: 60 },
  tcp_server: {},
  file_drop: { stable_seconds: 5, move_after_capture: false, captured_subdirectory: 'captured', allowed_types: ['pdf'] },
};
const FILE_DROP_DEFAULTS: Obj = KIND_DEFAULTS.file_drop;
const ASTM_DEFAULTS = Object.fromEntries(ASTM_OPTIONS.map(([k, , d]) => [k, d])) as Record<string, number>;

// H80-T06, LD-139 (binding): preset "Truth H80E" (08-ADDENDUM-TRUTH-H80E §1, §3, §7, §8, §9). The analyser is a TCP client; the address typed
// into it is the LAB PC running the bridge agent (tcp_server), never the cloud server and never 0.0.0.0. Every U position stays unverified:
// nothing here is seeded or guessed, the driver stays generic and host query inert until a reviewed migration promotes it.
const H80E = { driver: 'truth_h80e', vendor: 'Truth', model: 'Truth-H80E', protocol: 'hl7v2' as Protocol, kind: 'tcp_server' as TransportKind };
const H80E_CODES = ['HbA1c_NGSP', 'HbA1c_IFCC', 'HbF', 'HbA1', 'eAG', 'A1ab', 'HbLA1C+', 'HbA0', 'A1A', 'A1B'] as const; // §3 "analyte codes seen in the manual"
const H80E_RUNBOOK = 'docs/manual/instruments/truth-h80e-commissioning.md';
const H80E_CHECKLIST = [ // §9, wording kept close to the addendum
  "Vendor engineer sets the analyser's static IP (same subnet as the lab PC) and, with lab staff, the LIS address and port ([Apply] → [Set] → [Lis]). Ping the analyser from the lab PC; the LIS icon in the analyser turns green.",
  'Install the bridge agent on the lab PC with a static LAN IP. Create this instrument with transport tcp_server, then issue and use the enrolment code.',
  "Set the instrument state to commissioning (shadow). Run 5 patient samples and 2 QC runs, capture the raw messages and compare every value with the analyser's printout.",
  "Map the analyte codes (for example HbA1c_NGSP to the lab's HbA1c test) and review the mappings.",
  'Host query in shadow: scan a registered tube. Confirm QCK OK and DSR, that the analyser shows the patient and runs, and the ACK^Q03 reply.',
  'Scan an unregistered tube and a tube registered without HbA1c. Record what the analyser does on NF.',
  'Register a patient with a Devanagari name. Record whether the analyser screen shows it.',
  'Pull the internet link, scan a tube and record what happens. Restore the link and confirm queued results upload once, with no duplicates.',
  'Sign off. Promotion to verified is a reviewed migration plus a code change, not a switch in this form.',
] as const;

// MET-T05, LD-163 (binding): preset "Getein Metis series" (09-ADDENDUM-GETEIN-METIS §1, §3, §7, §8, §9). Same topology as H80E (D-MET-3): the analyser is
// assumed to connect out (U1), so transport tcp_server on the lab PC. The ids below are the addendum's examples only (U2): which ids a lab runs is
// confirmed at commissioning and C3 owns the code-map rows, so nothing is seeded. Driver stays generic and host query inert until a reviewed migration.
const METIS = { driver: 'getein_metis', vendor: 'Getein', model: 'Metis', protocol: 'hl7v2' as Protocol, kind: 'tcp_server' as TransportKind };
const METIS_CODES = [['0', 'ALT'], ['1', 'AST'], ['1112', 'CoV2Ag']] as const; // §3 example item ids
const METIS_RUNBOOK = 'docs/manual/instruments/getein-metis-commissioning.md';
const METIS_CHECKLIST = [ // §9, wording kept close to the addendum
  "Vendor engineer sets the analyser's static IP (same subnet as the lab PC) and its LIS settings, and confirms whether the analyser connects out to the LIS address typed into it or listens. If it listens, stop and raise CR-C7-021.",
  'Install the bridge agent on the lab PC with a static LAN IP. Create this instrument with transport tcp_server, then issue and use the enrolment code.',
  "Set the instrument state to commissioning (shadow). Run 5 patient samples and 2 QC runs per level in use, capture the raw messages and compare every value with the analyser's printout.",
  "Read the analyser's own item list and record which ids the lab runs. Map them to the lab's tests and review the mappings.",
  "Host query in shadow: scan a registered tube. Confirm QCK OK and DSR, that the analyser shows the sample and runs the listed tests, the ACK^Q03 form, and whether the QCK is acknowledged.",
  'Scan an unregistered tube and a tube registered without any test mapped to this analyser. Record what the analyser does on NF.',
  "Try the analyser's sample-number-range and time-range download once and record what it shows after NF. Ask the vendor engineer whether this unit accepts a LIS-pushed sample request. Decide with the lab manager whether CR-C7-022 is needed.",
  'Register a patient with a Devanagari name and record whether the analyser shows it. Record whether a calibration run arrives and is archived harmlessly.',
  'Pull the internet link, scan a tube and record what happens. Restore the link and confirm queued results upload once, with no duplicates. Sign off. Promotion to verified is a reviewed migration plus a code change, not a switch in this form.',
] as const;

interface OptionField { key: string; title: string; maxLength?: number; options?: string[]; numeric?: boolean; def: string }
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** One field per string / enum property of the driver's JSON Schema (own keys only; anything else is ignored, never rendered as HTML).
 *  A numeric enum (with or without `type`, e.g. truth_h80e host_query_detection_mode) is a Select whose value is sent back as a number. */
function optionFields(schema: Record<string, unknown> | undefined): OptionField[] {
  const props = schema && Object.hasOwn(schema, 'properties') ? schema['properties'] : undefined;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return [];
  const out: OptionField[] = [];
  for (const k of Object.keys(props)) {
    const p = (props as Record<string, unknown>)[k];
    if (UNSAFE_KEYS.has(k) || typeof p !== 'object' || p === null) continue;
    const { type, title, maxLength, enum: en, default: def } = p as Obj;
    const numEnum = Array.isArray(en) && en.length > 0 && en.every((x) => typeof x === 'number' && Number.isFinite(x))
      && (type === undefined || type === 'integer' || type === 'number');
    if (type !== 'string' && !numEnum) continue;
    out.push({
      key: k, title: typeof title === 'string' && title ? title : k,
      def: numEnum ? (typeof def === 'number' ? String(def) : '') : typeof def === 'string' ? def : '',
      ...(typeof maxLength === 'number' && maxLength > 0 && !numEnum ? { maxLength } : {}),
      ...(numEnum ? { options: (en as number[]).map(String), numeric: true }
        : Array.isArray(en) && en.every((x) => typeof x === 'string') && en.length ? { options: en as string[] } : {}),
    });
  }
  return out;
}
/** Driver JSON Schema of parser options. Field name pending .orchestra/cr/H80-T06.md (E22 Driver has no optionsSchema yet); read only here. */
const driverOptionsSchema = (d: Driver | undefined) => (d as (Driver & { options_schema?: Record<string, unknown> }) | undefined)?.options_schema;

interface State {
  instrument_code: string; display_name: string; vendor: string; model: string; serial_no: string; software_version: string;
  agent_id?: string | undefined; protocol?: Protocol | undefined; driver_code?: string | undefined;
  transport: Obj; peers: string; file_drop?: Obj | undefined; host_query: boolean;
  astm: Record<string, number | undefined>; hl7: Obj;
  preset: 'custom' | 'truth_h80e' | 'getein_metis'; popts: Record<string, string>; // popts: parser options the user touched (schema keys only)
  timezone?: string | undefined; qc: string; silence_window?: number | undefined; from: string; to: string;
}

const init = (i?: Instrument): State => ({
  instrument_code: i?.instrument_code ?? '', display_name: i?.display_name ?? '', vendor: i?.vendor ?? '', model: i?.model ?? '',
  serial_no: i?.serial_no ?? '', software_version: i?.software_version ?? '',
  ...(i?.agent_id ? { agent_id: i.agent_id } : {}), ...(i?.protocol ? { protocol: i.protocol } : {}), ...(i?.driver_code ? { driver_code: i.driver_code } : {}),
  transport: { ...(i?.transport ?? {}) }, peers: Array.isArray(i?.transport?.['allowed_peers']) ? (i!.transport!['allowed_peers'] as string[]).join(', ') : '',
  ...(i?.file_drop ? { file_drop: { ...i.file_drop } } : {}), host_query: i?.capabilities?.host_query ?? false,
  astm: { ...ASTM_DEFAULTS, ...(i?.protocol_options?.astm as Record<string, number> | undefined) }, hl7: { ...(i?.protocol_options?.hl7v2 ?? {}) },
  preset: 'custom', popts: {},
  ...(i?.timezone ? { timezone: i.timezone } : {}), qc: (i?.qc_sample_id_patterns ?? []).join('\n'),
  ...(i?.silence_window_minutes !== undefined ? { silence_window: i.silence_window_minutes } : {}), from: i?.silence_active_from ?? '', to: i?.silence_active_to ?? '',
});

/** @lims/ui Switch has no description prop: link the reason/error text to the real input so assistive tech reads it. */
function DescribedSwitch({ description, invalid, ...p }: { label: string; isSelected: boolean; onChange?: (v: boolean) => void; isDisabled?: boolean; name: string; description?: string | undefined; invalid?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const id = `${p.name.replace(/\W/g, '-')}-desc`;
  useEffect(() => {
    const input = root.current?.querySelector('input');
    if (!input) return;
    // react-aria re-renders the input without these props and strips them again: re-apply whenever they change.
    const apply = () => {
      if (description && input.getAttribute('aria-describedby') !== id) input.setAttribute('aria-describedby', id);
      if (!description && input.hasAttribute('aria-describedby')) input.removeAttribute('aria-describedby');
      if (invalid && input.getAttribute('aria-invalid') !== 'true') input.setAttribute('aria-invalid', 'true');
      if (!invalid && input.hasAttribute('aria-invalid')) input.removeAttribute('aria-invalid');
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(input, { attributes: true, attributeFilter: ['aria-describedby', 'aria-invalid'] });
    return () => mo.disconnect();
  }, [description, invalid, id]);
  return (
    <div ref={root} className="lims-field">
      <Switch {...p} {...on(p.isDisabled, { isDisabled: true })} />
      {description ? <span id={id} className={invalid ? 'lims-error' : 'lims-description'}>{description}</span> : null}
    </div>
  );
}

// ~400 IANA zones: react-aria builds the whole collection on every render, so this Select is memoised and only re-renders
// when its own value / error / state changes (not on every keystroke elsewhere in the form).
let zoneCache: string[] | undefined;
const allZones = () => (zoneCache ??= (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []);
const TimezoneSelect = memo(function TimezoneSelect({ value, error, disabled, onChange }: { value: string | undefined; error: string | undefined; disabled: boolean; onChange: (v: string) => void }) {
  const options = useMemo(() => (value && !allZones().includes(value) ? [value, ...allZones()] : allZones()).map((x) => ({ value: x, label: x })), [value]);
  return <Select<string> label="Timezone" name="timezone" options={options} {...on(value, { value: value! })} onChange={onChange} {...on(disabled, { isDisabled: true })} {...on(error, { error: error! })} />;
});

export function InstrumentForm({ mode, agents, drivers, instrument, permissions = [MANAGE], onDone }: { mode: 'create' | 'edit'; agents: readonly AgentOption[]; drivers: readonly Driver[]; instrument?: Instrument; permissions?: readonly string[]; onDone?: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const edit = mode === 'edit';
  const ro = edit && !hasPerm(permissions, MANAGE);
  const [s, setS] = useState<State>(() => init(instrument));
  const [serverErr, setServerErr] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<string[]>([]);
  const [mfa, setMfa] = useState(false);
  const [show, setShow] = useState(false);
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID()); // one key per form instance: a retry is the same create (02-CONVENTIONS §4.5)
  const inFlight = useRef(false);
  const done = useRef(false);
  const version = useRef(instrument?.version ?? 1);
  if (instrument && instrument.version > version.current) version.current = instrument.version;
  const seen = useRef(new Set<string>());
  seen.current = new Set();

  const driver = drivers.find((d) => d.code === s.driver_code);
  const declaresHostQuery = !!driver?.capabilities.host_query;
  const supportsHostQuery = declaresHostQuery && driver?.status === 'verified'; // 02-TRD §6.6 step 2: host query is inert until verified (LD-139)
  const optFields = useMemo(() => (edit ? [] : optionFields(driverOptionsSchema(driver))), [edit, driver]);
  const presetId = useId();
  const patch = (p: Partial<State>, ...ptrs: string[]) => {
    setS((x) => ({ ...x, ...p }));
    if (ptrs.length) setServerErr((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !ptrs.includes(k))));
  };
  const setT = (k: string, v: unknown) => patch({ transport: { ...s.transport, [k]: v } }, `/transport/${k}`);
  const setFD = (base: '/transport' | '/file_drop', k: string, v: unknown) => {
    if (base === '/transport') setT(k, v);
    else patch({ file_drop: { ...(s.file_drop ?? {}), [k]: v } }, `/file_drop/${k}`);
  };
  const kind = s.transport['kind'] as TransportKind | undefined;

  const build = (): Obj => {
    const b: Obj = {};
    if (!edit) {
      b['instrument_code'] = s.instrument_code;
      if (s.agent_id) b['agent_id'] = s.agent_id;
    }
    Object.assign(b, { display_name: s.display_name, vendor: s.vendor, model: s.model });
    if (s.serial_no) b['serial_no'] = s.serial_no;
    if (s.software_version) b['software_version'] = s.software_version;
    if (s.protocol) b['protocol'] = s.protocol;
    if (s.driver_code) b['driver_code'] = s.driver_code;
    if (kind) b['transport'] = clean({ ...s.transport, ...(kind === 'tcp_server' ? { allowed_peers: s.peers.split(',').map((x) => x.trim()).filter(Boolean) } : {}) });
    const orig = instrument?.protocol_options;
    const opts = (cur: Obj, was: Obj | undefined, defaults: Record<string, number>) => Object.fromEntries(Object.entries(cur).filter(([k, v]) => v !== undefined && v !== '' && (was?.[k] !== undefined || v !== defaults[k])));
    const astm = s.protocol === 'astm' ? opts(s.astm, orig?.astm, ASTM_DEFAULTS) : {};
    const hl7 = s.protocol === 'hl7v2' ? opts(s.hl7, orig?.hl7v2, {}) : {};
    if (Object.keys(astm).length || Object.keys(hl7).length) b['protocol_options'] = { ...(Object.keys(astm).length ? { astm } : {}), ...(Object.keys(hl7).length ? { hl7v2: hl7 } : {}) };
    const po = Object.fromEntries(optFields.filter((f) => Object.hasOwn(s.popts, f.key) && s.popts[f.key] !== f.def && s.popts[f.key] !== '').map((f) => [f.key, f.numeric ? Number(s.popts[f.key]) : s.popts[f.key]]));
    if (Object.keys(po).length) b['parser_options'] = po;
    if (s.file_drop && s.protocol !== 'file_drop') b['file_drop'] = clean(s.file_drop);
    b['capabilities'] = { host_query: s.host_query && supportsHostQuery, worklist_download: false }; // worklist download: never true (AC-03.4)
    const qc = s.qc.split('\n').map((x) => x.trim()).filter(Boolean);
    if (qc.length) b['qc_sample_id_patterns'] = qc;
    if (s.timezone) b['timezone'] = s.timezone;
    if (s.silence_window !== undefined) b['silence_window_minutes'] = s.silence_window;
    if (s.from) b['silence_active_from'] = s.from;
    if (s.to) b['silence_active_to'] = s.to;
    return b;
  };

  const vmode = mode === 'edit' ? 'update' : 'create';
  const clientErr =fieldErrorsByPointer(validateInstrument(build(), vmode));
  const E = (ptr: string, value: unknown = 'x') => {
    seen.current.add(ptr);
    const e = serverErr[ptr] ?? (show || nz(value) ? clientErr[ptr] : undefined);
    return e ? { error: e } : {};
  };
  const ROF = { ...on(ro, { isReadOnly: true }) };

  const tf = (label: string, ptr: string, value: string, max: number, set: (v: string) => void, o: { required?: boolean; description?: string; readOnly?: boolean } = {}) => (
    <TextField label={label} name={nameOf(ptr)} maxLength={max} value={value} onChange={(v) => { set(v); setServerErr(({ [ptr]: _, ...r }) => r); }} {...on(o.required && !ro, { isRequired: true })} {...on(o.description, { description: o.description! })} {...(o.readOnly ? { isReadOnly: true } : ROF)} {...E(ptr, value)} />
  );
  const nf = (label: string, ptr: string, value: number | undefined, min: number, max: number, set: (v: number | undefined) => void, description?: string) => (
    <IntegerField label={label} name={nameOf(ptr)} min={min} max={max} {...on(value !== undefined, { value: value! })} onChange={(v) => { set(v); setServerErr(({ [ptr]: _, ...r }) => r); }} {...on(description, { description: description! })} {...ROF} {...E(ptr, value)} />
  );
  const sel = (label: string, ptr: string, value: string | undefined, options: readonly { value: string; label: string; isDisabled?: boolean }[], set: (v: string) => void, o: { required?: boolean; disabled?: boolean } = {}) => (
    <Select<string> label={label} name={nameOf(ptr)} options={options} {...on(value !== undefined, { value: value! })} onChange={(v) => { set(v); setServerErr(({ [ptr]: _, ...r }) => r); }} {...on(o.required && !ro, { isRequired: true })} {...on(o.disabled || ro, { isDisabled: true })} {...E(ptr, value)} />
  );

  const fileDrop = (base: '/transport' | '/file_drop', o: Obj) => {
    const types = Array.isArray(o['allowed_types']) ? (o['allowed_types'] as string[]) : [];
    const typesErr = E(`${base}/allowed_types`, types);
    return (
      <>
        {tf('Folder path', `${base}/directory`, String(o['directory'] ?? ''), 240, (v) => setFD(base, 'directory', v))}
        {tf('File name pattern', `${base}/filename_pattern`, String(o['filename_pattern'] ?? ''), 200, (v) => setFD(base, 'filename_pattern', v))}
        {tf('Barcode pattern', `${base}/barcode_regex`, String(o['barcode_regex'] ?? ''), 200, (v) => setFD(base, 'barcode_regex', v))}
        <div role="group" aria-label="Types" className="lims-field">
          <span className="lims-label">Types</span>
          {FILE_TYPES.map((t) => (
            <Checkbox key={t} label={FILE_TYPE_LABEL[t]} name={`${nameOf(base)}.type.${t}`} isSelected={types.includes(t)} {...on(ro, { isDisabled: true })} onChange={(on_) => setFD(base, 'allowed_types', on_ ? [...types, t] : types.filter((x) => x !== t))} />
          ))}
          {'error' in typesErr ? <span className="lims-error">{typesErr.error}</span> : null}
        </div>
        {nf('Stable seconds', `${base}/stable_seconds`, o['stable_seconds'] as number | undefined, 2, 60, (v) => setFD(base, 'stable_seconds', v))}
        <DescribedSwitch label="Move after capture" name={`${nameOf(base)}.move_after_capture`} isSelected={o['move_after_capture'] === true} onChange={(v) => setFD(base, 'move_after_capture', v)} isDisabled={ro} />
        {tf('Captured subfolder', `${base}/captured_subdirectory`, String(o['captured_subdirectory'] ?? ''), 60, (v) => setFD(base, 'captured_subdirectory', v))}
        {tf('Attachment code', `${base}/attachment_instrument_code`, String(o['attachment_instrument_code'] ?? ''), 64, (v) => setFD(base, 'attachment_instrument_code', v))}
      </>
    );
  };

  const setProtocol = (p: Protocol) => {
    const allowed = TRANSPORT_KINDS_BY_PROTOCOL[p];
    const k = kind && allowed.includes(kind) ? kind : allowed.length === 1 ? allowed[0] : undefined;
    const driverOk = !s.driver_code || drivers.find((d) => d.code === s.driver_code)?.protocol === p;
    patch({ protocol: p, transport: k ? (k === kind ? s.transport : { kind: k, ...KIND_DEFAULTS[k] }) : {}, ...(driverOk ? {} : { host_query: false, driver_code: undefined }) }, '/protocol', '/transport/kind');
  };
  const setKind = (k: string) => patch({ transport: { kind: k, ...KIND_DEFAULTS[k as TransportKind] } }, '/transport/kind');
  const setDriver = (code: string) => {
    const d = drivers.find((x) => x.code === code);
    patch({ driver_code: code, popts: {}, ...(d?.capabilities.host_query && d.status === 'verified' ? {} : { host_query: false }) }, '/driver_code', '/capabilities/host_query');
  };
  const setPreset = (v: string) => {
    const p = v === 'truth_h80e' ? H80E : v === 'getein_metis' ? METIS : undefined;
    if (!p) return patch({ preset: 'custom' });
    const known = drivers.some((d) => d.code === p.driver && d.protocol === p.protocol);
    patch({
      preset: v as 'truth_h80e' | 'getein_metis', vendor: p.vendor, model: p.model, protocol: p.protocol, transport: { kind: p.kind, ...KIND_DEFAULTS[p.kind] }, peers: '',
      popts: {}, host_query: false, ...(known ? { driver_code: p.driver } : { driver_code: undefined }),
    }, '/protocol', '/transport/kind', '/driver_code');
  };
  const h80 = s.preset === 'truth_h80e';
  const metis = s.preset === 'getein_metis';
  const lanPreset = h80 || metis; // both: analyser connects out to the lab PC (tcp_server)

  const agentOptions = agents.filter((a) => a.status === 'active' || a.status === 'pending_enrolment' || a.id === s.agent_id).map((a) => ({ value: a.id, label: `${a.agent_code} — ${a.display_name}` }));
  if (s.agent_id && !agentOptions.some((o) => o.value === s.agent_id)) agentOptions.push({ value: s.agent_id, label: instrument?.['agent_code' as keyof Instrument] as string ?? s.agent_id });
  const showSketch = process.env.NODE_ENV !== 'production'; // 04-UI-UX SCR-06: sketch drivers are listed only outside production
  const driverOptions = drivers
    .filter((d) => d.is_active && (!s.protocol || d.protocol === s.protocol) && (showSketch || d.status !== 'sketch_blocked'))
    .map((d) => ({ value: d.code, label: `${d.display_name} — ${driverStatusLabel(d.status)}` }));
  const kindOptions = (s.protocol ? TRANSPORT_KINDS_BY_PROTOCOL[s.protocol] : []).map((k) => ({ value: k, label: KIND_LABEL[k] }));
  const patchRef = useRef(patch);
  patchRef.current = patch;
  const onZone = useCallback((v: string) => patchRef.current({ timezone: v }, '/timezone'), []);
  const zoneErr = 'error' in E('/timezone', s.timezone) ? (E('/timezone', s.timezone) as { error: string }).error : undefined;

  const problemTitle = (code: string) => (code === 'common.version_conflict' ? 'Someone else changed this instrument. Reload to see the latest version.' : `Could not save the instrument (${code})`);

  const submit = async () => {
    if (ro || done.current || inFlight.current) return;
    setShow(true);
    setMfa(false);
    setAlerts([]);
    const body = build();
    const issues = validateInstrument(body, vmode);
    if (issues.length) {
      setAlerts(issues.filter((i) => !seen.current.has(i.path)).map((i) => i.message));
      return;
    }
    let payload: Obj = body;
    if (edit) {
      payload = Object.fromEntries(Object.entries(instrumentBody(body, 'update')).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((instrument as unknown as Obj)[k])));
      if (!Object.keys(payload).length) {
        toast.show({ tone: 'info', title: 'No changes to save.' });
        return;
      }
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const r = edit ? await updateInstrumentAction(instrument!.id, version.current, payload as Partial<InstrumentBody>) : await createInstrumentAction(payload as InstrumentBody, idempotencyKey);
      if (r.ok) {
        done.current = !edit;
        setServerErr({});
        if (edit) {
          version.current = (r.data as { version: number }).version;
          toast.show({ tone: 'success', title: 'Saved. The agent picks this up within a minute.' });
          router.refresh();
        } else {
          toast.show({ tone: 'success', title: 'Instrument created.' });
          onDone?.();
          router.push(`/instruments/instruments/${(r.data as { id: string }).id}`);
        }
        return;
      }
      if (r.code === 'auth.mfa_required') { setMfa(true); return; }
      const mapped = fieldErrorsByPointer(r.errors);
      const known: Record<string, string> = {};
      const loose: string[] = [];
      for (const [p, m] of Object.entries(mapped)) (seen.current.has(p) ? (known[p] = m) : loose.push(m));
      if (r.code === 'instruments.code_duplicate') known['/instrument_code'] = 'An instrument with this code already exists.'; // [CONV] text
      else if (r.code === 'instruments.capability_not_supported' && !Object.keys(known).length) known['/capabilities/host_query'] = 'The driver does not support host query.';
      setServerErr(known);
      if (loose.length) setAlerts(loose);
      else if (!Object.keys(known).length) setAlerts([problemTitle(r.code)]);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const hostErr = E('/capabilities/host_query');
  const hostDesc = 'error' in hostErr ? hostErr.error : supportsHostQuery ? undefined
    : declaresHostQuery ? `Host query stays off while this driver's status is ${driverStatusLabel(driver!.status).toLowerCase()}. It can be switched on only after commissioning is signed off and the driver is promoted to verified.`
    : 'This driver does not support host query.';
  const regionCard = (id: string, title: string, children: ReactNode) => (
    <div className="lims-card"><section aria-labelledby={`${presetId}-${id}`}><h2 id={`${presetId}-${id}`} className="lims-card-title">{title}</h2>{children}</section></div>
  );
  const section = (title: string, children: ReactNode) => <Card title={title}>{children}</Card>;

  return (
    // Ctrl/Cmd+Enter submits from any control: react-aria buttons (Select triggers) swallow Enter before the Form's own handler sees it.
    <section
      aria-label={edit ? 'Instrument configuration' : 'New instrument form'}
      onKeyDownCapture={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          void submit();
        }
      }}
    >
    <Form onSubmit={submit}>
      {mfa ? <Banner tone="warning" title="Confirm with your authenticator to continue" /> : null}
      {alerts.length ? (
        <div role="alert">
          <Banner tone="danger" title={alerts.length === 1 ? alerts[0]! : 'Some values were not accepted'}>
            {alerts.length > 1 ? <ul>{alerts.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
          </Banner>
        </div>
      ) : null}

      {edit ? null : section('Preset', <>
        <Select<string> label="Preset" name="preset" options={[{ value: 'custom', label: 'Custom' }, { value: 'truth_h80e', label: 'Truth H80E' }, { value: 'getein_metis', label: 'Getein Metis series' }]} value={s.preset} onChange={setPreset} />
        {h80 ? <p className="lims-description">The Truth-H80E connects out to the address typed into the analyser ([Apply] → [Set] → [Lis]). That address is the lab PC that runs the bridge agent, not the cloud server. Use the lab PC's static LAN IP below, never 0.0.0.0.</p> : null}
        {metis ? <p className="lims-description">The Metis analyser is assumed to connect out to the LIS address typed into the analyser (confirmed at commissioning, step 1). That address is the lab PC that runs the bridge agent, not the cloud server: the analyser speaks plain MLLP with no TLS. Use the lab PC's static LAN IP below, never 0.0.0.0.</p> : null}
      </>)}

      {section('Identity', <>
        {tf('Code', '/instrument_code', s.instrument_code, 32, (v) => patch({ instrument_code: v.toUpperCase() }), { required: true, readOnly: edit })}
        {tf('Name', '/display_name', s.display_name, 80, (v) => patch({ display_name: v }), { required: true })}
        {tf('Vendor', '/vendor', s.vendor, 60, (v) => patch({ vendor: v }), { required: true })}
        {tf('Model', '/model', s.model, 60, (v) => patch({ model: v }), { required: true })}
        {tf('Serial no', '/serial_no', s.serial_no, 60, (v) => patch({ serial_no: v }))}
        {tf('Software version', '/software_version', s.software_version, 40, (v) => patch({ software_version: v }), { description: "Interface behaviour can change with software version — record it from the instrument's About screen." })}
      </>)}

      {section('Connection', <>
        {sel('Agent', '/agent_id', s.agent_id, agentOptions, (v) => patch({ agent_id: v }), { required: true, disabled: edit })}
        <RadioGroup<Protocol> label="Protocol" name="protocol" options={PROTOCOL_OPTIONS as { value: Protocol; label: string }[]} orientation="horizontal" {...on(s.protocol, { value: s.protocol! })} onChange={setProtocol} {...on(!ro, { isRequired: true })} {...ROF} {...E('/protocol', s.protocol)} />
        {sel('Transport kind', '/transport/kind', kind, kindOptions, setKind, { required: true })}
        {kind === 'serial' ? (
          <>
            {tf('Port', '/transport/port_name', String(s.transport['port_name'] ?? ''), 6, (v) => setT('port_name', v))}
            {sel('Baud rate', '/transport/baud_rate', s.transport['baud_rate'] === undefined ? undefined : String(s.transport['baud_rate']), BAUD_RATES.map((b) => ({ value: String(b), label: String(b) })), (v) => setT('baud_rate', Number(v)))}
            {sel('Data bits', '/transport/data_bits', s.transport['data_bits'] === undefined ? undefined : String(s.transport['data_bits']), DATA_BITS.map((b) => ({ value: String(b), label: String(b) })), (v) => setT('data_bits', Number(v)))}
            {sel('Parity', '/transport/parity', s.transport['parity'] as string | undefined, PARITIES.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) })), (v) => setT('parity', v))}
            {sel('Stop bits', '/transport/stop_bits', s.transport['stop_bits'] as string | undefined, STOP_BITS.map((b) => ({ value: b, label: b })), (v) => setT('stop_bits', v))}
            <DescribedSwitch label="DTR" name="transport.dtr" isSelected={s.transport['dtr'] !== false} onChange={(v) => setT('dtr', v)} isDisabled={ro} />
            <DescribedSwitch label="RTS" name="transport.rts" isSelected={s.transport['rts'] !== false} onChange={(v) => setT('rts', v)} isDisabled={ro} />
            <p className="lims-description">Use the values from the instrument's LIS/host interface manual.</p>
          </>
        ) : null}
        {kind === 'tcp_client' ? (
          <>
            {tf('Host', '/transport/host', String(s.transport['host'] ?? ''), 253, (v) => setT('host', v))}
            {nf('Port', '/transport/port', s.transport['port'] as number | undefined, 1, 65535, (v) => setT('port', v))}
            {nf('Connect timeout (s)', '/transport/connect_timeout_s', s.transport['connect_timeout_s'] as number | undefined, 1, 60, (v) => setT('connect_timeout_s', v))}
            {nf('Reconnect max back-off (s)', '/transport/reconnect_max_backoff_s', s.transport['reconnect_max_backoff_s'] as number | undefined, 1, 300, (v) => setT('reconnect_max_backoff_s', v))}
          </>
        ) : null}
        {kind === 'tcp_server' ? (
          <>
            <Banner tone="warning" title="The agent will accept connections on the lab network. Run 'bridge-agent firewall enable' on the PC." />
            {tf(lanPreset ? "Listen address: the lab PC's static LAN IP" : 'Listen address', '/transport/bind_address', String(s.transport['bind_address'] ?? ''), 15, (v) => setT('bind_address', v), lanPreset ? { description: 'Type this same address into the analyser as the LIS address.' } : {})}
            {nf('Port', '/transport/port', s.transport['port'] as number | undefined, 1024, 65535, (v) => setT('port', v))}
            {tf(lanPreset ? 'Allowed analyser addresses' : 'Allowed instrument addresses', '/transport/allowed_peers', s.peers, 100, (v) => patch({ peers: v }, '/transport/allowed_peers'), { description: lanPreset ? "The analyser's own static IP. IPv4 addresses, separated by commas (1–8)." : 'IPv4 addresses, separated by commas (1–8).' })}
          </>
        ) : null}
        {kind === 'file_drop' ? fileDrop('/transport', s.transport) : null}
      </>)}

      {section('Driver', <>
        {sel('Driver', '/driver_code', s.driver_code, driverOptions, setDriver, { required: true })}
        {optFields.map((f) => {
          const val = Object.hasOwn(s.popts, f.key) ? s.popts[f.key]! : f.def;
          const set = (v: string) => patch({ popts: { ...s.popts, [f.key]: v } });
          return f.options
            ? <Select<string> key={f.key} label={`Analyser option: ${f.title}`} name={`parser_options.${f.key}`} options={f.options.map((o) => ({ value: o, label: o }))} {...on(val, { value: val })} onChange={set} />
            : <TextField key={f.key} label={`Analyser option: ${f.title}`} name={`parser_options.${f.key}`} maxLength={f.maxLength ?? 64} value={val} onChange={set} />;
        })}
        <TimezoneSelect value={s.timezone} error={zoneErr} disabled={ro} onChange={onZone} />
        <TextArea label="QC sample ID patterns" name="qc_sample_id_patterns" maxLength={1010} rows={3} description="One pattern per line, up to 10." value={s.qc} onChange={(v) => patch({ qc: v }, '/qc_sample_id_patterns')} {...ROF} {...E('/qc_sample_id_patterns', s.qc)} />
      </>)}

      {section('Protocol options', <>
        <Button variant="ghost" onPress={() => setAdv((x) => !x)}>Advanced link settings</Button>
        {adv ? (
          <div>
            <p className="lims-description">Default values, taken from a published vendor implementation of LIS1-A. Use the values in this instrument's manual when it gives them.</p>
            {s.protocol === 'hl7v2' ? (
              <>
                {tf('ACK mode', '/protocol_options/hl7v2/ack_mode', String(s.hl7['ack_mode'] ?? ''), 32, (v) => patch({ hl7: { ...s.hl7, ack_mode: v } }))}
                {tf('ACK sending application', '/protocol_options/hl7v2/ack_sending_app', String(s.hl7['ack_sending_app'] ?? ''), 20, (v) => patch({ hl7: { ...s.hl7, ack_sending_app: v } }))}
                {tf('ACK sending facility', '/protocol_options/hl7v2/ack_sending_facility', String(s.hl7['ack_sending_facility'] ?? ''), 20, (v) => patch({ hl7: { ...s.hl7, ack_sending_facility: v } }))}
                {HL7_OPTIONS.map(([k, label, min, max]) => <div key={k}>{nf(label, `/protocol_options/hl7v2/${k}`, s.hl7[k] as number | undefined, min, max, (v) => patch({ hl7: { ...s.hl7, [k]: v } }))}</div>)}
              </>
            ) : s.protocol === 'file_drop' ? (
              <p className="lims-description">Folder-only instruments have no link settings.</p>
            ) : (
              // ASTM is the default view until a protocol is chosen
              ASTM_OPTIONS.map(([k, label, , min, max]) => <div key={k}>{nf(label, `/protocol_options/astm/${k}`, s.astm[k], min, max, (v) => patch({ astm: { ...s.astm, [k]: v } }))}</div>)
            )}
          </div>
        ) : null}
      </>)}

      {section('Capabilities', <>
        <DescribedSwitch label="Host query" name="capabilities.host_query" isSelected={s.host_query && supportsHostQuery} onChange={(v) => patch({ host_query: v }, '/capabilities/host_query')} isDisabled={ro || !supportsHostQuery} description={hostDesc} invalid={'error' in hostErr} />
        <DescribedSwitch label="Worklist download" name="capabilities.worklist_download" isSelected={false} isDisabled description="Not available yet" />
        {s.protocol !== 'file_drop' ? (
          <DescribedSwitch label="Picture/PDF folder" name="capabilities.file_drop" isSelected={!!s.file_drop} onChange={(v) => patch({ file_drop: v ? (s.file_drop ?? { ...FILE_DROP_DEFAULTS }) : undefined })} isDisabled={ro} />
        ) : null}
        {s.file_drop && s.protocol !== 'file_drop' ? fileDrop('/file_drop', s.file_drop) : null}
      </>)}

      {section('Monitoring', <>
        {nf('Silence window (minutes)', '/silence_window_minutes', s.silence_window, 15, 1440, (v) => patch({ silence_window: v }), 'Optional. Raise an alert when no message arrives for this long.')}
        {tf('Active from', '/silence_active_from', s.from, 5, (v) => patch({ from: v }), { description: 'HH:MM, optional.' })}
        {tf('Active to', '/silence_active_to', s.to, 5, (v) => patch({ to: v }), { description: 'HH:MM, optional.' })}
      </>)}

      {h80 ? regionCard('codes', 'Suggested analyte codes', <>
        <p className="lims-description">Codes the analyser sends (manual). Nothing is created here: map them to the lab's tests on the instrument's code map after it is created.</p>
        <ul>{H80E_CODES.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      </>) : null}
      {h80 ? regionCard('checklist', 'Commissioning checklist', <>
        <ol>{H80E_CHECKLIST.map((t, i) => <li key={i}>{t}</li>)}</ol>
        <p className="lims-description">Runbook: {H80E_RUNBOOK}</p>
      </>) : null}
      {metis ? regionCard('codes', 'Suggested analyte codes', <>
        <p className="lims-description">Item ids shown in the addendum's examples. Item ids are the analyser's own; which ones this lab runs is confirmed at commissioning from the analyser's item list. Nothing is created here: map them to the lab's tests on the instrument's code map after it is created.</p>
        <ul>{METIS_CODES.map(([id, name]) => <li key={id}><code>{id}</code> {name}</li>)}</ul>
      </>) : null}
      {metis ? regionCard('checklist', 'Commissioning checklist', <>
        <ol>{METIS_CHECKLIST.map((t, i) => <li key={i}>{t}</li>)}</ol>
        <p className="lims-description">Runbook: {METIS_RUNBOOK}</p>
      </>) : null}

      {ro ? null : <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy}>{edit ? 'Save' : 'Create instrument'}</Button>}
    </Form>
    </section>
  );
}

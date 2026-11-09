'use client';
// SCR-06 Instrument form (04-UI-UX §3): create in a Dialog (SCR-05), edit on the SCR-07 Configuration tab.
// Schema-driven: client validation = forms/instrument.ts (same rules as the BFF), server errors[] are mapped by JSON Pointer.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

interface State {
  instrument_code: string; display_name: string; vendor: string; model: string; serial_no: string; software_version: string;
  agent_id?: string | undefined; protocol?: Protocol | undefined; driver_code?: string | undefined;
  transport: Obj; peers: string; file_drop?: Obj | undefined; host_query: boolean;
  astm: Record<string, number | undefined>; hl7: Obj;
  timezone?: string | undefined; qc: string; silence_window?: number | undefined; from: string; to: string;
}

const init = (i?: Instrument): State => ({
  instrument_code: i?.instrument_code ?? '', display_name: i?.display_name ?? '', vendor: i?.vendor ?? '', model: i?.model ?? '',
  serial_no: i?.serial_no ?? '', software_version: i?.software_version ?? '',
  ...(i?.agent_id ? { agent_id: i.agent_id } : {}), ...(i?.protocol ? { protocol: i.protocol } : {}), ...(i?.driver_code ? { driver_code: i.driver_code } : {}),
  transport: { ...(i?.transport ?? {}) }, peers: Array.isArray(i?.transport?.['allowed_peers']) ? (i!.transport!['allowed_peers'] as string[]).join(', ') : '',
  ...(i?.file_drop ? { file_drop: { ...i.file_drop } } : {}), host_query: i?.capabilities?.host_query ?? false,
  astm: { ...ASTM_DEFAULTS, ...(i?.protocol_options?.astm as Record<string, number> | undefined) }, hl7: { ...(i?.protocol_options?.hl7v2 ?? {}) },
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
  const supportsHostQuery = !!driver?.capabilities.host_query;
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
    patch({ driver_code: code, ...(d?.capabilities.host_query ? {} : { host_query: false }) }, '/driver_code', '/capabilities/host_query');
  };

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
  const hostDesc = 'error' in hostErr ? hostErr.error : supportsHostQuery ? undefined : 'This driver does not support host query.';
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
            {tf('Listen address', '/transport/bind_address', String(s.transport['bind_address'] ?? ''), 15, (v) => setT('bind_address', v))}
            {nf('Port', '/transport/port', s.transport['port'] as number | undefined, 1024, 65535, (v) => setT('port', v))}
            {tf('Allowed instrument addresses', '/transport/allowed_peers', s.peers, 100, (v) => patch({ peers: v }, '/transport/allowed_peers'), { description: 'IPv4 addresses, separated by commas (1–8).' })}
          </>
        ) : null}
        {kind === 'file_drop' ? fileDrop('/transport', s.transport) : null}
      </>)}

      {section('Driver', <>
        {sel('Driver', '/driver_code', s.driver_code, driverOptions, setDriver, { required: true })}
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

      {ro ? null : <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy}>{edit ? 'Save' : 'Create instrument'}</Button>}
    </Form>
    </section>
  );
}

'use client';
// Delta rules tab (04-UI-UX §3.13; 02-TRD §5.8 #49-#52; PRD AC-12.4): every version row of the tenant's rules; New rule (#50), New version (#51, If-Match "<row version>", effective_from
// optional = from now) and Deactivate (#52, confirm first, If-Match). A version never rewrites an older one. Thresholds / window are validated here as well (mirrors delta_check_rules__*__ck;
// the API re-checks). Write controls need lab.config.manage; the API enforces it too.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { IdText } from '@lims/ui/components/IdText';
import { useToast } from '@lims/ui/components/Toast';
import { createDeltaRuleAction, deactivateDeltaRuleAction, listDeltaRulesAction, versionDeltaRuleAction } from '../../server/config.actions';
import type { DeltaRule, DeltaRuleBody } from '../../server/config.types';
import { UUID_RE, type ActionResult } from '../../server/types';
import { call, newKey, utc } from '../shared';
import { AlertText, errText, isStale, TextInput } from './common';

const DEC = /^[0-9]+(\.[0-9]+)?$/;
const windowText = (s: number) => (s % 86400 === 0 ? `${s / 86400} d` : s % 3600 === 0 ? `${s / 3600} h` : `${s} s`);

interface RuleForm { analyte: string; hours: string; abs: string; pct: string; unit: string; from: string }
type RuleErrors = Partial<Record<keyof RuleForm, string>>;
const EMPTY: RuleForm = { analyte: '', hours: '', abs: '', pct: '', unit: '', from: '' };
type Dlg = { kind: 'create' } | { kind: 'version'; rule: DeltaRule } | { kind: 'deactivate'; rule: DeltaRule } | null;

/** Form -> request body, or the field messages. effective_from (datetime-local) is read as UTC and sent as an ISO UTC instant; empty = omitted (the API uses "now"). */
function build(f: RuleForm, withAnalyte: boolean): { body: DeltaRuleBody } | { errors: RuleErrors } {
  const errors: RuleErrors = {};
  const abs = f.abs.trim(), pct = f.pct.trim(), hours = f.hours.trim();
  if (withAnalyte && !UUID_RE.test(f.analyte.trim())) errors.analyte = 'Enter the analyte ID (a UUID).';
  if (!/^[0-9]{1,4}$/.test(hours) || Number(hours) < 1 || Number(hours) > 8760) errors.hours = 'Window must be a whole number of hours between 1 and 8760.';
  if (!abs && !pct) errors.abs = 'Enter at least one threshold.';
  else {
    if (abs && (!DEC.test(abs) || !(Number(abs) > 0))) errors.abs = 'Absolute threshold must be greater than 0.';
    if (pct && (!DEC.test(pct) || !(Number(pct) > 0) || Number(pct) > 1000)) errors.pct = 'Percent threshold must be greater than 0 and at most 1000.';
  }
  const unit = f.unit.trim();
  if (!unit || unit.length > 100) errors.unit = 'Enter the unit (1 to 100 characters).';
  let effective: string | undefined;
  if (f.from) {
    const ms = Date.parse(`${f.from}${f.from.length === 16 ? ':00' : ''}Z`);
    if (Number.isNaN(ms)) errors.from = 'Enter a valid date and time.'; else effective = new Date(ms).toISOString();
  }
  if (Object.keys(errors).length) return { errors };
  return { body: { ...(withAnalyte ? { analyte_id: f.analyte.trim().toLowerCase() } : {}), window_seconds: Number(hours) * 3600, ...(abs ? { abs_threshold: abs } : {}), ...(pct ? { pct_threshold: pct } : {}), unit_code: unit, ...(effective ? { effective_from: effective } : {}) } };
}

export function DeltaRulesTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [rules, setRules] = useState<DeltaRule[] | null>(null);
  const [err, setErr] = useState('');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [f, setF] = useState<RuleForm>(EMPTY);
  const [errs, setErrs] = useState<RuleErrors>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const key = useRef<{ sig: string; key: string } | null>(null);   // one Idempotency-Key per distinct payload: a retry re-sends the same key

  const load = useCallback(async () => {
    const r = await call(listDeltaRulesAction());
    if (r.ok) setRules(r.data); else setErr(errText(r));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const close = () => { setDlg(null); setErrs({}); };
  const openCreate = () => { setErr(''); setErrs({}); setF(EMPTY); setDlg({ kind: 'create' }); };
  const openVersion = (rule: DeltaRule) => {
    setErr(''); setErrs({});
    setF({ analyte: '', hours: rule.window_seconds % 3600 === 0 ? String(rule.window_seconds / 3600) : '', abs: rule.abs_threshold ?? '', pct: rule.pct_threshold ?? '', unit: rule.unit_code, from: '' });
    setDlg({ kind: 'version', rule });
  };

  /** One request at a time. Success closes the dialog and reloads; 409 / 428 and a refused Deactivate close it and show the problem on the page; other failures stay in the dialog. */
  async function act(send: () => Promise<ActionResult<unknown>>, done: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setErr('');
    const r = await call(send());
    busyRef.current = false; setBusy(false);
    if (r.ok) { key.current = null; close(); toast.show({ tone: 'success', title: done }); return load(); }
    setErr(errText(r));
    if (isStale(r) || dlg?.kind === 'deactivate') close();
    if (isStale(r)) await load();
  }

  function submit() {
    if (!dlg || dlg.kind === 'deactivate') return;
    const built = build(f, dlg.kind === 'create');
    if ('errors' in built) return setErrs(built.errors);
    setErrs({});
    const sig = JSON.stringify([dlg.kind, dlg.kind === 'version' ? dlg.rule.id : '', built.body]);
    if (key.current?.sig !== sig) key.current = { sig, key: newKey() };
    const k = key.current.key;
    return act(() => (dlg.kind === 'create' ? createDeltaRuleAction(built.body, k) : versionDeltaRuleAction(dlg.rule.id, dlg.rule.version, built.body, k)), 'Rule saved');
  }
  const deactivate = () => dlg?.kind === 'deactivate' && act(() => deactivateDeltaRuleAction(dlg.rule.id, dlg.rule.version), 'Rule deactivated');

  const inDialog = dlg !== null;
  if (rules === null) return err ? <AlertText text={err} /> : <p role="status">Loading…</p>;
  const set = (k: keyof RuleForm) => (v: string) => setF({ ...f, [k]: v });
  return (
    <div>
      {inDialog ? null : <AlertText text={err} />}
      {canManage ? <Button variant="primary" onPress={openCreate}>New rule</Button> : null}
      {rules.length === 0 ? <p>No delta rules.</p> : (
        <table className="lims-table">
          <thead>
            <tr><th scope="col">Analyte</th><th scope="col">Window</th><th scope="col">Abs</th><th scope="col">Pct</th><th scope="col">Unit</th><th scope="col">Version</th><th scope="col">Effective from</th><th scope="col">Active</th>{canManage ? <th scope="col">Actions</th> : null}</tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td><IdText value={r.analyte_id} /></td><td>{windowText(r.window_seconds)}</td><td>{r.abs_threshold ?? '—'}</td><td>{r.pct_threshold ?? '—'}</td><td>{r.unit_code}</td>
                <td>{`v${r.rule_version}`}</td><td>{utc(r.effective_from)}</td><td><span>{r.is_active ? 'Active' : 'Inactive'}</span></td>
                {canManage ? (
                  <td>
                    {r.effective_to === undefined ? <Button variant="secondary" size="sm" onPress={() => openVersion(r)}>New version</Button> : null}
                    {r.is_active && r.effective_to === undefined ? <Button variant="danger" size="sm" onPress={() => { setErr(''); setDlg({ kind: 'deactivate', rule: r }); }}>Deactivate</Button> : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        title={dlg?.kind === 'version' ? 'New rule version' : 'New delta rule'}
        isOpen={dlg?.kind === 'create' || dlg?.kind === 'version'}
        onClose={close}
        footer={<><Button variant="ghost" onPress={close}>Cancel</Button><Button variant="primary" isDisabled={busy} onPress={() => void submit()}>Save rule</Button></>}
      >
        <AlertText text={err} />
        {dlg?.kind === 'create' ? <TextInput label="Analyte ID" value={f.analyte} onChange={set('analyte')} error={errs.analyte} /> : null}
        <TextInput label="Window (hours)" type="number" value={f.hours} onChange={set('hours')} error={errs.hours} />
        <TextInput label="Absolute threshold" inputMode="decimal" value={f.abs} onChange={set('abs')} error={errs.abs} />
        <TextInput label="Percent threshold" inputMode="decimal" value={f.pct} onChange={set('pct')} error={errs.pct} />
        <TextInput label="Unit" value={f.unit} onChange={set('unit')} error={errs.unit} />
        <TextInput label="Effective from (UTC, optional)" type="datetime-local" value={f.from} onChange={set('from')} error={errs.from} />
      </Dialog>

      <Dialog
        title="Deactivate rule"
        isOpen={dlg?.kind === 'deactivate'}
        onClose={close}
        footer={<><Button variant="ghost" onPress={close}>Cancel</Button><Button variant="danger" isDisabled={busy} onPress={() => void deactivate()}>Deactivate</Button></>}
      >
        <p>This rule will no longer be applied to new results. Results already evaluated keep the rule version they were checked with.</p>
      </Dialog>
    </div>
  );
}

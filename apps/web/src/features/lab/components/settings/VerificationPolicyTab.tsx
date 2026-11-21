'use client';
// Verification levels tab of /lab/settings (T0D-VERLEVEL-1, LD-316, LD-318 follow-up 4, LD-353 template 4 SETTINGS). Level 1, 2 or 3 = the number of DIFFERENT people who must
// sign off a result; the lab policy is the base, a department or test policy overrides it (most specific wins). Saving sends If-Match "<version>" only when the target already has an
// active policy (lab.yaml upsertVerificationPolicy). Only lab.verification_policy.manage edits; the API enforces it again (REQ-SEC-062). Heights and text sizes come from the density tokens.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { useToast } from '@lims/ui/components/Toast';
import type { CatalogOption, PolicyScope, VerificationPolicy } from '../../server/config.types';
import { listDepartmentOptionsAction, listTestOptionsAction, listVerificationPoliciesAction, upsertVerificationPolicyAction } from '../../server/config.actions';
import { call, utc } from '../shared';
import { AlertText, CheckInput, errText, Field, isStale, TextInput } from './common';

type Level = '1' | '2' | '3';
interface Form { level: Level; pathologist: boolean; enterer: boolean }
const DEFAULTS: Form = { level: '2', pathologist: true, enterer: false }; // LD-316: level 2 + pathologist reproduces today; LD-318: enterer may not verify by default
const LINE: Record<Level, string> = {
  '1': '1 person must sign off a result before it is final.',
  '2': '2 different people must sign off a result before it is final.',
  '3': '3 different people must sign off a result before it is final.',
};
const SCOPES = [{ value: 'lab', label: 'Whole lab' }, { value: 'department', label: 'One department' }, { value: 'test', label: 'One test' }] as const;
const LEVELS = [{ value: '1', label: 'Level 1' }, { value: '2', label: 'Level 2' }, { value: '3', label: 'Level 3' }] as const;
const COLS = 7;
const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const toForm = (p: VerificationPolicy | undefined): Form => (p ? { level: String(p.required_verifiers) as Level, pathologist: p.require_pathologist, enterer: p.allow_enterer_verify } : DEFAULTS);

export function VerificationPolicyTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [policies, setPolicies] = useState<VerificationPolicy[] | null>(null);
  const [depts, setDepts] = useState<CatalogOption[]>([]);
  const [tests, setTests] = useState<CatalogOption[]>([]);
  const [readErr, setReadErr] = useState('');
  const [err, setErr] = useState('');
  const [scope, setScope] = useState<PolicyScope>('lab');
  const [target, setTarget] = useState(''); // department_id or test_id
  const [q, setQ] = useState('');
  const [f, setF] = useState<Form>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    const r = await call(listVerificationPoliciesAction());
    if (r.ok) { setPolicies(r.data); setReadErr(''); } else setReadErr(errText(r));
    return r.ok ? r.data : null;
  }, []);
  useEffect(() => {
    void load().then((list) => { if (list) setF(toForm(list.find((p) => p.active && p.scope === 'lab'))); });
    // a failing catalog read only costs the names (the table falls back to the short id)
    void call(listDepartmentOptionsAction()).then((r) => r.ok && setDepts(r.data));
    void call(listTestOptionsAction()).then((r) => r.ok && setTests(r.data));
  }, [load]);

  const find = (list: readonly VerificationPolicy[], s: PolicyScope, id: string) =>
    list.find((p) => p.active && p.scope === s && (s === 'lab' || (s === 'department' ? p.department_id : p.test_id) === id));
  const pick = (s: PolicyScope, id: string) => {
    setScope(s); setTarget(id); setErr('');
    setF(s === 'lab' || id ? toForm(find(policies ?? [], s, id)) : DEFAULTS);
  };

  async function save() {
    if (busyRef.current || !policies) return;
    if (scope !== 'lab' && !target) return setErr(scope === 'department' ? 'Choose a department first.' : 'Choose a test first.');
    const current = find(policies, scope, target);
    busyRef.current = true; setBusy(true); setErr('');
    const r = await call(upsertVerificationPolicyAction({
      scope, ...(scope === 'department' ? { department_id: target } : scope === 'test' ? { test_id: target } : {}),
      required_verifiers: Number(f.level), require_pathologist: f.pathologist, allow_enterer_verify: f.enterer,
    }, current?.version));
    busyRef.current = false; setBusy(false);
    if (r.ok) { toast.show({ tone: 'success', title: 'Verification policy saved' }); await load(); return; }
    setErr(errText(r));
    if (isStale(r)) await load();
  }

  if (policies === null) return readErr ? <AlertText text={readErr} /> : <p role="status">Loading…</p>;
  const nameOf = (p: VerificationPolicy) => {
    const id = (p.scope === 'department' ? p.department_id : p.test_id) ?? '';
    return (p.scope === 'department' ? depts : tests).find((o) => o.id === id)?.name ?? id.slice(0, 8);
  };
  const overrides = policies.filter((p) => p.active && p.scope !== 'lab');
  const needle = q.trim().toLowerCase();
  const matches = tests.filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.code.toLowerCase().includes(needle)).slice(0, 20);
  const ro = !canManage;

  return (
    <div className="lims-settings-form">
      <AlertText text={err} />
      <RadioGroup label="Apply to" name="policy-scope"orientation="horizontal" value={scope} isDisabled={ro} options={SCOPES} onChange={(s) => pick(s, '')} />
      {scope === 'department' ? (
        <Field label="Department">
          {(p) => (
            <select {...p} className="lims-input" value={target} disabled={ro} onChange={(e) => pick('department', e.currentTarget.value)}>
              <option value="">—</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </Field>
      ) : null}
      {scope === 'test' ? (
        <>
          <TextInput label="Search tests" value={q} disabled={ro} onChange={setQ} />
          <ul className="lims-chip-list" aria-label="Matching tests">
            {matches.map((t) => (
              <li key={t.id}>
                <Button variant={target === t.id ? 'primary' : 'secondary'} size="sm" isDisabled={ro} onPress={() => pick('test', t.id)}>{`${t.name} (${t.code})`}</Button>
              </li>
            ))}
          </ul>
          {target ? <p className="lims-description">{`Chosen test: ${tests.find((t) => t.id === target)?.name ?? target.slice(0, 8)}`}</p> : null}
        </>
      ) : null}
      <RadioGroup label="Verification level" name="policy-level"orientation="horizontal" value={f.level} isDisabled={ro} options={LEVELS} description={LINE[f.level]} onChange={(level) => setF({ ...f, level })} />
      <CheckInput label="Require a pathologist" checked={f.pathologist} disabled={ro} onChange={(pathologist) => setF({ ...f, pathologist })} />
      <CheckInput label="Let the person who entered a result also verify it" checked={f.enterer} disabled={ro} onChange={(enterer) => setF({ ...f, enterer })} />
      <p className="lims-description">Accreditation bodies expect a second person to check every result.</p>
      {canManage ? <Button variant="primary" isLoading={busy} onPress={() => void save()}>Save policy</Button> : null}

      <div className="lims-data-table">
        <div className="lims-table-scroll">
          <table className="lims-table" aria-label="Verification level overrides">
            <thead>
              <tr><th scope="col">Scope</th><th scope="col">Name</th><th scope="col" className="lims-align-end lims-num">Level</th><th scope="col">Pathologist required</th><th scope="col">Entered-by may verify</th><th scope="col">Updated by</th><th scope="col">Updated at</th></tr>
            </thead>
            <tbody>
              {overrides.length === 0 ? <EmptyRow colSpan={COLS}><EmptyState title="No overrides yet" body="Every result uses the whole lab level." /></EmptyRow> : overrides.map((p) => {
                const name = nameOf(p);
                return (
                  <tr key={p.id}>
                    <td>{p.scope === 'department' ? 'Department' : 'Test'}</td>
                    <td title={name}>{name}</td>
                    <td className="lims-align-end lims-num">{p.required_verifiers}</td>
                    <td>{yesNo(p.require_pathologist)}</td>
                    <td>{yesNo(p.allow_enterer_verify)}</td>
                    <td>—</td>{/* VerificationPolicy has no updated-by field yet */}
                    <td>{utc(p.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
            {overrides.length === 0 ? <PlaceholderRows colSpan={COLS} /> : null}
          </table>
        </div>
      </div>
    </div>
  );
}

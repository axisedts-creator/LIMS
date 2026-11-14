'use client';
// SCR-17 Tax rules & tax types (04-UI-UX §4, D-C3-04): nothing about tax is assumed. The disclaimer Banner is always visible (every
// tab, empty state, read-only) and again next to each setting; the VAT treatment has no default; only tax types that have a rate can
// be picked in a rule. The VAT type is a system row (read-only).
import { useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { Combobox } from '@lims/ui/components/Combobox';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { searchOrderablesAction } from '../server/catalogActions';
import { createTaxRuleAction, createTaxTypeAction, endTaxRuleAction, updateTaxTypeAction } from '../server/pricingActions';
import { HS_CODE_RE, parsePercentBp, TAX_CODE_RE, TAX_DISCLAIMER, type Department, type OrderableSummary, type TaxRule, type TaxType } from '../server/types';
import { errAt, fmtDateTime } from './shared';
import { ActionDialog, canManagePrices, TaxDisclaimer, useWhen } from './pricing-ui';

type Scope = TaxRule['scope'];
type Vat = TaxRule['vat_treatment'];
const NONE = '__none';
const SCOPE_OPTIONS = [{ value: 'tenant_default', label: 'Lab default' }, { value: 'department', label: 'Department' }, { value: 'orderable', label: 'Orderable' }] as const;
const RATE_ERROR = 'Enter a rate between 0 and 100 % with at most 2 decimals.';
const NO_RATE = 'Not configured — cannot be used in rules';
const pct = (bp: number) => `${bp / 100} %`;
const ended = (r: { effective_to?: string }, now: number) => r.effective_to !== undefined && Date.parse(r.effective_to) <= now;

export function TaxScreen({ rules, taxTypes, departments, orderables, permissions }: {
  rules: readonly TaxRule[];
  taxTypes: readonly TaxType[];
  departments: readonly Pick<Department, 'id' | 'name'>[];
  orderables: readonly Pick<OrderableSummary, 'id' | 'code' | 'name'>[];
  permissions: readonly string[];
}) {
  const manage = canManagePrices(permissions);
  const [tab, setTab] = useState('rules');
  const [dialog, setDialog] = useState<'rule' | 'type' | { end: TaxRule } | { edit: TaxType }>();
  const now = Date.now();
  const hasDefault = rules.some((r) => r.scope === 'tenant_default' && !ended(r, now));
  const vatBp = taxTypes.find((t) => t.code === 'VAT')?.rate_bp ?? 1300;
  const rateOf = (code?: string) => { const t = taxTypes.find((x) => x.code === code); return t?.rate_bp !== undefined ? ` ${pct(t.rate_bp)}` : ''; };
  const appliesTo = (r: TaxRule) => (r.scope === 'tenant_default' ? 'Lab default' : r.scope === 'department' ? `Department ${departments.find((d) => d.id === r.department_id)?.name ?? r.department_id}` : `Orderable ${(() => { const o = orderables.find((x) => x.id === r.orderable_id); return o ? `${o.code} — ${o.name}` : r.orderable_id; })()}`);

  return (
    <section aria-label="Tax rules and tax types">
      <PageHeader title="Tax rules & tax types" helpKey="catalog.tax" breadcrumbs={[{ label: 'Pricing' }, { label: 'Tax' }]} />
      <Banner tone="info" title={`${TAX_DISCLAIMER} Configure what your auditor confirms.`} />
      <Tabs aria-label="Tax" items={[{ id: 'rules', label: 'Rules' }, { id: 'types', label: 'Tax types' }]} selectedId={tab} onChange={setTab}>
        {tab === 'rules' ? (
          <>
            {!hasDefault ? <div role="alert"><Banner tone="danger" title="Prices cannot be quoted until a lab default tax rule exists." /></div> : null}
            {manage ? <Button variant="primary" onPress={() => setDialog('rule')}>New rule</Button> : null}
            {rules.length === 0 ? (
              <EmptyState title="No tax rules. Prices cannot be quoted until a tenant default rule exists." />
            ) : (
              <table className="lims-table lims-table-regular">
                <caption className="lims-visually-hidden">Tax rules</caption>
                <thead>
                  <tr>
                    {['Applies to', 'VAT', 'Other tax', 'HS code', 'Effective from', 'Effective to'].map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}
                    {manage ? <th scope="col" className="lims-col-actions"><VisuallyHidden>Actions</VisuallyHidden></th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="lims-row">
                      <td className="lims-cell">{appliesTo(r)}</td>
                      <td className="lims-cell">{r.vat_treatment === 'exempt' ? 'Exempt' : `Taxable ${pct(vatBp)}`}</td>
                      <td className="lims-cell">{r.other_tax_code ? `${r.other_tax_code}${rateOf(r.other_tax_code)}` : '—'}</td>
                      <td className="lims-cell">{r.hs_code ?? '—'}</td>
                      <td className="lims-cell">{fmtDateTime(r.effective_from)}</td>
                      <td className="lims-cell">{fmtDateTime(r.effective_to) || '—'}</td>
                      {manage ? <td className="lims-cell-actions">{ended(r, now) ? null : <Button size="sm" variant="ghost" onPress={() => setDialog({ end: r })}>End rule<VisuallyHidden> {appliesTo(r)}</VisuallyHidden></Button>}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <>
            {manage ? <Button variant="primary" onPress={() => setDialog('type')}>New tax type</Button> : null}
            <table className="lims-table lims-table-regular">
              <caption className="lims-visually-hidden">Tax types</caption>
              <thead>
                <tr>
                  {['Code', 'Name', 'Rate', 'Effective from', 'Effective to', 'Scope'].map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}
                  {manage ? <th scope="col" className="lims-col-actions"><VisuallyHidden>Actions</VisuallyHidden></th> : null}
                </tr>
              </thead>
              <tbody>
                {taxTypes.map((t) => (
                  <tr key={t.id} className="lims-row">
                    <td className="lims-cell">{t.code}</td>
                    <td className="lims-cell">{t.display}</td>
                    <td className="lims-cell">{t.rate_bp !== undefined ? pct(t.rate_bp) : NO_RATE}</td>
                    <td className="lims-cell">{fmtDateTime(t.effective_from)}</td>
                    <td className="lims-cell">{fmtDateTime(t.effective_to) || '—'}</td>
                    <td className="lims-cell">{t.scope === 'global' ? 'System' : 'Lab'}</td>
                    {manage ? <td className="lims-cell-actions">{t.scope === 'tenant' ? <Button size="sm" variant="ghost" onPress={() => setDialog({ edit: t })}>Edit<VisuallyHidden> {t.code}</VisuallyHidden></Button> : null}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Tabs>
      {dialog === 'rule' ? <NewRuleDialog taxTypes={taxTypes} departments={departments} onClose={() => setDialog(undefined)} /> : null}
      {dialog === 'type' ? <NewTypeDialog onClose={() => setDialog(undefined)} /> : null}
      {dialog && typeof dialog === 'object' && 'end' in dialog ? <EndRuleDialog rule={dialog.end} onClose={() => setDialog(undefined)} /> : null}
      {dialog && typeof dialog === 'object' && 'edit' in dialog ? <EditTypeDialog type={dialog.edit} onClose={() => setDialog(undefined)} /> : null}
    </section>
  );
}

function NewRuleDialog({ taxTypes, departments, onClose }: { taxTypes: readonly TaxType[]; departments: readonly Pick<Department, 'id' | 'name'>[]; onClose: () => void }) {
  const when = useWhen();
  const [scope, setScope] = useState<Scope>();
  const [deptId, setDeptId] = useState<string>();
  const [orderable, setOrderable] = useState<OrderableSummary>();
  const [vat, setVat] = useState<Vat>();
  const [other, setOther] = useState(NONE);
  const [hs, setHs] = useState('');
  const [hsError, setHsError] = useState<string>();
  const [scopeError, setScopeError] = useState<string>();
  const rated = taxTypes.filter((t) => t.rate_bp !== undefined && t.is_active); // only types with a rate can be used (AC-15.2)

  const check = () => {
    const h = hs.trim() && !HS_CODE_RE.test(hs.trim()) ? 'Enter 4 to 8 digits.' : undefined;
    const s = scope === 'department' && !deptId ? 'Choose a department.' : scope === 'orderable' && !orderable ? 'Choose a test or panel.' : undefined;
    setHsError(h);
    setScopeError(s);
    return !h && !s;
  };
  const body = () => ({
    scope,
    ...(scope === 'department' ? { department_id: deptId } : {}),
    ...(scope === 'orderable' ? { orderable_id: orderable?.id } : {}),
    vat_treatment: vat,
    ...(other !== NONE ? { other_tax_code: other } : {}),
    ...(hs.trim() ? { hs_code: hs.trim() } : {}),
    effective_from: when.get(),
  });
  return (
    <ActionDialog title="New tax rule" savedText="Tax rule saved." onClose={onClose} check={check} run={(key) => createTaxRuleAction(body(), key)}>
      {(fail) => (
        <>
          <TaxDisclaimer />
          <Select<Scope> label="Applies to" name="scope" isRequired options={SCOPE_OPTIONS} {...(scope ? { value: scope } : {})} onChange={(v) => { setScope(v); setScopeError(undefined); }} />
          {scope === 'department' ? <Select label="Department" name="department_id" isRequired options={departments.map((d) => ({ value: d.id, label: d.name }))} {...(deptId ? { value: deptId } : {})} onChange={setDeptId} {...(scopeError ? { error: scopeError } : {})} /> : null}
          {scope === 'orderable' ? (
            <Combobox<OrderableSummary> label="Test or panel" name="orderable_id" isRequired {...(orderable ? { value: orderable } : {})} onChange={setOrderable} loadOptions={searchOrderablesAction} getKey={(o) => o.id} renderOption={(o) => `${o.code} — ${o.name}`} renderValue={(o) => `${o.code} — ${o.name}`} {...(scopeError ? { error: scopeError } : {})} />
          ) : null}
          <RadioGroup<Vat> label="VAT treatment" name="vat_treatment" isRequired options={[{ value: 'exempt', label: 'Exempt' }, { value: 'taxable', label: 'Taxable' }]} {...(vat ? { value: vat } : {})} onChange={setVat} />
          <Select label="Other tax type" name="other_tax_code" value={other} onChange={setOther} options={[{ value: NONE, label: 'None' }, ...rated.map((t) => ({ value: t.code, label: `${t.code} — ${t.display} (${pct(t.rate_bp!)})` }))]} {...(errAt(fail, '/other_tax_code') ? { error: errAt(fail, '/other_tax_code')! } : {})} />
          <TextField label="HS code" name="hs_code" inputMode="numeric" maxLength={8} description="Optional. Applicability to lab services is not confirmed." value={hs} onChange={(v) => { setHs(v); setHsError(undefined); }} {...(hsError ?? errAt(fail, '/hs_code') ? { error: (hsError ?? errAt(fail, '/hs_code'))! } : {})} />
          <DateTimePicker label="Effective from" name="effective_from" value={when.value} onChange={when.onChange} {...(errAt(fail, '/effective_from') ? { error: errAt(fail, '/effective_from')! } : {})} />
        </>
      )}
    </ActionDialog>
  );
}

function EndRuleDialog({ rule, onClose }: { rule: TaxRule; onClose: () => void }) {
  const when = useWhen();
  return (
    <ActionDialog title="End rule" submit="End rule" savedText="Tax rule ended." onClose={onClose} run={() => endTaxRuleAction(rule.id, rule.version, { effective_to: when.get() })}>
      {(fail) => <DateTimePicker label="Ends on" name="effective_to" value={when.value} onChange={when.onChange} {...(errAt(fail, '/effective_to') ? { error: errAt(fail, '/effective_to')! } : {})} />}
    </ActionDialog>
  );
}

const rateBp = (text: string) => (text.trim() === '' ? { empty: true as const } : { bp: parsePercentBp(text) });
const rateBad = (text: string) => { const r = rateBp(text); return 'bp' in r && (r.bp === undefined || r.bp > 10000); };

function NewTypeDialog({ onClose }: { onClose: () => void }) {
  const when = useWhen();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [rateError, setRateError] = useState<string>();
  const check = () => { const e = rateBad(rate) ? RATE_ERROR : undefined; setRateError(e); return !e; };
  return (
    <ActionDialog title="New tax type" savedText="Tax type saved." onClose={onClose} check={check}
      run={(key) => { const r = rateBp(rate); return createTaxTypeAction({ code: code.trim(), display: name.trim(), ...('bp' in r ? { rate_bp: r.bp } : {}), effective_from: when.get() }, key); }}>
      {(fail) => (
        <>
          <TaxDisclaimer />
          <CodeField label="Code" name="code" maxLength={16} pattern={TAX_CODE_RE.source} patternHint="Capital letters, digits and _, up to 16." isRequired value={code} onChange={setCode} />
          <TextField label="Name" name="display" maxLength={60} isRequired value={name} onChange={setName} />
          <TextField label="Rate (%)" name="rate_bp" inputMode="decimal" description="0 to 100. May stay empty: the type then cannot be used in rules." value={rate} onChange={(v) => { setRate(v); setRateError(undefined); }} {...(rateError ? { error: rateError } : {})} />
          <DateTimePicker label="Effective from" name="effective_from" value={when.value} onChange={when.onChange} {...(errAt(fail, '/effective_from') ? { error: errAt(fail, '/effective_from')! } : {})} />
        </>
      )}
    </ActionDialog>
  );
}

function EditTypeDialog({ type, onClose }: { type: TaxType; onClose: () => void }) {
  const when = useWhen();
  const [name, setName] = useState(type.display);
  const [rate, setRate] = useState(type.rate_bp !== undefined ? String(type.rate_bp / 100) : '');
  const [rateError, setRateError] = useState<string>();
  const check = () => { const e = rateBad(rate) ? RATE_ERROR : undefined; setRateError(e); return !e; };
  const body = () => {
    const r = rateBp(rate);
    const rateChanged = 'bp' in r && r.bp !== type.rate_bp;
    return { ...(name.trim() !== type.display ? { display: name.trim() } : {}), ...(rateChanged ? { rate_bp: r.bp, effective_from: when.get() } : {}) };
  };
  return (
    <ActionDialog title={`Edit tax type ${type.code}`} savedText="Tax type saved." onClose={onClose} check={check} run={() => updateTaxTypeAction(type.id, type.version, body())}>
      {(fail) => (
        <>
          <TaxDisclaimer />
          <TextField label="Name" name="display" maxLength={60} isRequired value={name} onChange={setName} />
          <TextField label="Rate (%)" name="rate_bp" inputMode="decimal" description="A new rate starts at the date below; earlier rates stay unchanged." value={rate} onChange={(v) => { setRate(v); setRateError(undefined); }} {...(rateError ? { error: rateError } : {})} />
          <DateTimePicker label="Effective from" name="effective_from" value={when.value} onChange={when.onChange} {...(errAt(fail, '/effective_from') ? { error: errAt(fail, '/effective_from')! } : {})} />
        </>
      )}
    </ActionDialog>
  );
}

'use client';
// SCR-16 Urgent surcharge rules (04-UI-UX §4). A percent rule is entered as % (0.01–1000) and sent as basis points; a flat rule
// as integer paisa. No rule is not an error: urgent tests are then charged at the normal price (AC-14.4).
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { searchOrderablesAction } from '../server/catalogActions';
import { createSurchargeRuleAction, endSurchargeRuleAction } from '../server/pricingActions';
import { formatNpr, parseNpr, parsePercentBp, type Department, type OrderableSummary, type PriceList, type SurchargeRule } from '../server/types';
import { errAt, fmtDateTime } from './shared';
import { ActionDialog, canManagePrices, npr, useWhen } from './pricing-ui';

type Scope = SurchargeRule['scope'];
type Kind = SurchargeRule['amount_kind'];
const ALL_LISTS = 'all';
const PERCENT_ERROR = 'Enter a percentage between 0.01 and 1000, with at most 2 decimals.';
const AMOUNT_ERROR = 'Enter an amount between 0.00 and 9,999,999.99 with at most 2 decimals.';
const HELP = 'Applies only when the order item is marked Urgent. The most specific rule wins: orderable, then department, then all tests.';

const statusOf = (r: SurchargeRule, now = Date.now()) => (Date.parse(r.effective_from) > now ? 'Scheduled' : r.effective_to && Date.parse(r.effective_to) <= now ? 'Ended' : 'Active');

export function SurchargeRulesScreen({ rules, departments, orderables, priceLists, permissions }: {
  rules: readonly SurchargeRule[];
  departments: readonly Pick<Department, 'id' | 'name'>[];
  orderables: readonly Pick<OrderableSummary, 'id' | 'code' | 'name'>[];
  priceLists: readonly Pick<PriceList, 'id' | 'code' | 'name'>[];
  permissions: readonly string[];
}) {
  const manage = canManagePrices(permissions);
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState<SurchargeRule>();
  const open = manage ? () => setCreating(true) : undefined;
  const dept = (id?: string) => departments.find((d) => d.id === id)?.name ?? id ?? '—';
  const ord = (id?: string) => { const o = orderables.find((x) => x.id === id); return o ? `${o.code} — ${o.name}` : (id ?? '—'); };
  const appliesTo = (r: SurchargeRule) => (r.scope === 'all' ? 'All tests' : r.scope === 'department' ? `Department ${dept(r.department_id)}` : `Orderable ${ord(r.orderable_id)}`);
  const list = (id?: string) => { const p = priceLists.find((x) => x.id === id); return id ? (p ? p.name : id) : 'All'; };
  const now = Date.now();
  return (
    <section aria-label="Urgent surcharge rules">
      <PageHeader title="Urgent surcharge rules" helpKey="catalog.surcharges" breadcrumbs={[{ label: 'Pricing' }, { label: 'Urgent surcharge' }]} actions={open ? <Button variant="primary" onPress={open}>New rule</Button> : null} />
      <p>{HELP}</p>
      {rules.length === 0 ? (
        <EmptyState title="No urgent surcharge rules. Urgent tests are charged at the normal price." />
      ) : (
        <table className="lims-table lims-table-regular">
          <caption className="lims-visually-hidden">Urgent surcharge rules</caption>
          <thead>
            <tr>
              {['Applies to', 'Price list', 'Amount', 'Effective from', 'Effective to', 'Status'].map((h) => <th key={h} scope="col" className="lims-col">{h}</th>)}
              {manage ? <th scope="col" className="lims-col-actions"><VisuallyHidden>Actions</VisuallyHidden></th> : null}
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="lims-row">
                <td className="lims-cell">{appliesTo(r)}</td>
                <td className="lims-cell">{list(r.price_list_id)}</td>
                <td className="lims-cell">{r.amount_kind === 'flat' && r.amount ? npr(r.amount.amount_paisa) : r.percent_bp !== undefined ? `${r.percent_bp / 100} %` : '—'}</td>
                <td className="lims-cell">{fmtDateTime(r.effective_from)}</td>
                <td className="lims-cell">{fmtDateTime(r.effective_to) || '—'}</td>
                <td className="lims-cell">{statusOf(r, now)}</td>
                {manage ? (
                  <td className="lims-cell-actions">
                    {statusOf(r, now) !== 'Ended' ? <Button size="sm" variant="ghost" onPress={() => setEnding(r)}>End rule<VisuallyHidden> {appliesTo(r)}</VisuallyHidden></Button> : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating ? <NewRuleDialog departments={departments} priceLists={priceLists} onClose={() => setCreating(false)} /> : null}
      {ending ? <EndRuleDialog rule={ending} onClose={() => setEnding(undefined)} /> : null}
    </section>
  );
}

function NewRuleDialog({ departments, priceLists, onClose }: { departments: readonly Pick<Department, 'id' | 'name'>[]; priceLists: readonly Pick<PriceList, 'id' | 'code' | 'name'>[]; onClose: () => void }) {
  const when = useWhen();
  const [scope, setScope] = useState<Scope>();
  const [deptId, setDeptId] = useState<string>();
  const [orderable, setOrderable] = useState<OrderableSummary>();
  const [list, setList] = useState(ALL_LISTS);
  const [kind, setKind] = useState<Kind>();
  const [amount, setAmount] = useState('');
  const [percent, setPercent] = useState('');
  const [valueError, setValueError] = useState<string>();
  const [scopeError, setScopeError] = useState<string>();

  const check = () => {
    const sErr = (scope === 'department' && !deptId) ? 'Choose a department.' : (scope === 'orderable' && !orderable) ? 'Choose a test or panel.' : undefined;
    const bp = parsePercentBp(percent);
    const vErr = kind === 'flat' ? (parseNpr(amount) === undefined ? AMOUNT_ERROR : undefined) : kind === 'percent' ? (bp === undefined || bp < 1 || bp > 100000 ? PERCENT_ERROR : undefined) : undefined;
    setScopeError(sErr);
    setValueError(vErr);
    return !sErr && !vErr;
  };
  const body = () => ({
    scope,
    ...(scope === 'department' ? { department_id: deptId } : {}),
    ...(scope === 'orderable' ? { orderable_id: orderable?.id } : {}),
    ...(list !== ALL_LISTS ? { price_list_id: list } : {}),
    amount_kind: kind,
    ...(kind === 'flat' ? { amount: { amount_paisa: parseNpr(amount), currency: 'NPR' } } : { percent_bp: parsePercentBp(percent) }),
    effective_from: when.get(),
  });
  return (
    <ActionDialog title="New urgent surcharge rule" savedText="Rule saved." onClose={onClose} check={check} run={(key) => createSurchargeRuleAction(body(), key)}>
      {(fail) => (
        <>
          <RadioGroup<Scope> label="Applies to" name="scope" isRequired options={[{ value: 'all', label: 'All tests' }, { value: 'department', label: 'Department' }, { value: 'orderable', label: 'Orderable' }]} {...(scope ? { value: scope } : {})} onChange={(v) => { setScope(v); setScopeError(undefined); }} />
          {scope === 'department' ? <Select label="Department" name="department_id" isRequired options={departments.map((d) => ({ value: d.id, label: d.name }))} {...(deptId ? { value: deptId } : {})} onChange={setDeptId} {...(scopeError ? { error: scopeError } : {})} /> : null}
          {scope === 'orderable' ? (
            <Combobox<OrderableSummary> label="Test or panel" name="orderable_id" isRequired {...(orderable ? { value: orderable } : {})} onChange={setOrderable} loadOptions={searchOrderablesAction} getKey={(o) => o.id} renderOption={(o) => `${o.code} — ${o.name}`} renderValue={(o) => `${o.code} — ${o.name}`} {...(scopeError ? { error: scopeError } : {})} />
          ) : null}
          <Select label="Price list" name="price_list_id" value={list} onChange={setList} options={[{ value: ALL_LISTS, label: 'All price lists' }, ...priceLists.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))]} />
          <RadioGroup<Kind> label="Surcharge type" name="amount_kind" isRequired orientation="horizontal" options={[{ value: 'flat', label: 'Flat' }, { value: 'percent', label: 'Percent' }]} {...(kind ? { value: kind } : {})} onChange={(v) => { setKind(v); setValueError(undefined); }} />
          {kind === 'flat' ? <TextField label="Amount (NPR)" name="amount" inputMode="decimal" isRequired value={amount} onChange={(v) => { setAmount(v); setValueError(undefined); }} {...(valueError ? { error: valueError } : {})} /> : null}
          {kind === 'percent' ? <TextField label="Percent" name="percent_bp" inputMode="decimal" isRequired description="0.01 to 1000 %" value={percent} onChange={(v) => { setPercent(v); setValueError(undefined); }} {...(valueError ? { error: valueError } : {})} /> : null}
          <DateTimePicker label="Effective from" name="effective_from" value={when.value} onChange={when.onChange} {...(errAt(fail, '/effective_from') ? { error: errAt(fail, '/effective_from')! } : {})} />
        </>
      )}
    </ActionDialog>
  );
}

function EndRuleDialog({ rule, onClose }: { rule: SurchargeRule; onClose: () => void }) {
  const when = useWhen();
  return (
    <ActionDialog title="End rule" submit="End rule" savedText="Rule ended." onClose={onClose} run={() => endSurchargeRuleAction(rule.id, rule.version, { effective_to: when.get() })}>
      {(fail) => (
        <>
          <p>{`The rule stops applying from the date below. Rate: ${rule.amount_kind === 'flat' && rule.amount ? `NPR ${formatNpr(rule.amount.amount_paisa)}` : `${(rule.percent_bp ?? 0) / 100} %`}.`}</p>
          <DateTimePicker label="Ends on" name="effective_to" value={when.value} onChange={when.onChange} {...(errAt(fail, '/effective_to') ? { error: errAt(fail, '/effective_to')! } : {})} />
        </>
      )}
    </ActionDialog>
  );
}

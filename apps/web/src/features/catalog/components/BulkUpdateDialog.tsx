'use client';
// T0D-PRICETOOLS-1 (LD-321): "Bulk update" of a DRAFT price list version (SCR-14). Percent (basis points) or fixed amount (signed paisa), rounding, scope.
// The API has no preview operation, so the preview of the first 20 changed rows is computed here with the same integer half-up maths the server applies
// (priceToolsMath.applyChange); nothing is sent until Apply. A result below 0 in the scope blocks Apply (the server would refuse the whole request).
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { bulkUpdateDraftAction } from '../server/pricingActions';
import { applyChange, fmt2, parseAmountPaisa, parsePercentBp, ROUNDINGS, type Change, type Rounding } from './priceToolsMath';
import { newKey } from './shared';

export interface BulkRow { id: string; code: string; departmentId?: string | undefined; paisa: number }
type Kind = 'percent' | 'fixed_amount';
type Scope = 'all' | 'department' | 'listed_tests';
const PREVIEW_MAX = 20;
const k = (s: string) => t(`catalog.price_tools.${s}`);
const Alert = ({ text }: { text: string }) => <div role="alert" className="lims-error"><p>{text}</p></div>;

export function BulkUpdateDialog({ versionId, rows, departments, onClose }: {
  versionId: string;
  rows: readonly BulkRow[];
  departments: readonly { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('percent');
  const [percent, setPercent] = useState('');
  const [amount, setAmount] = useState('');
  const [rounding, setRounding] = useState<Rounding>('none');
  const [scope, setScope] = useState<Scope>('all');
  const [dept, setDept] = useState<string>();
  const [codes, setCodes] = useState('');
  const [fail, setFail] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const key = useRef<string>(undefined);

  const text = kind === 'percent' ? percent : amount;
  const parsed = kind === 'percent' ? parsePercentBp(percent) : parseAmountPaisa(amount);
  const change: Change | undefined = parsed === undefined ? undefined : kind === 'percent' ? { kind, bp: parsed } : { kind, paisa: parsed };

  const plan = useMemo(() => {
    let inScope: readonly BulkRow[] = rows;
    let unknown: string[] = [];
    let ids: string[] = [];
    let scopeError: string | undefined;
    if (scope === 'department') {
      inScope = dept ? rows.filter((r) => r.departmentId === dept) : [];
      if (!dept) scopeError = k('bulk.pick_department');
    } else if (scope === 'listed_tests') {
      const byCode = new Map(rows.map((r) => [r.code.toUpperCase(), r]));
      const typed = [...new Set(codes.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
      unknown = typed.filter((c) => !byCode.has(c));
      inScope = typed.flatMap((c) => byCode.get(c) ?? []);
      ids = inScope.map((r) => r.id);
      if (typed.length === 0) scopeError = k('bulk.codes_empty');
      else if (unknown.length) scopeError = `${k('bulk.codes_unknown')} ${unknown.join(', ')}`;
    }
    const out = change ? inScope.map((r) => ({ ...r, next: applyChange(r.paisa, change, rounding) })) : [];
    return { ids, scopeError, negative: out.filter((r) => r.next < 0), changed: out.filter((r) => r.next >= 0 && r.next !== r.paisa) };
  }, [rows, scope, dept, codes, change?.kind, parsed, rounding]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = !!change && !plan.scopeError && plan.negative.length === 0;
  const canApply = valid && plan.changed.length > 0 && !busy;

  const apply = async () => {
    if (inflight.current || !canApply || !change) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    key.current ??= newKey();
    try {
      const body = {
        change_kind: kind,
        ...(change.kind === 'percent' ? { percent_bp: change.bp } : { amount_paisa: change.paisa }),
        rounding,
        scope,
        ...(scope === 'department' ? { department_id: dept } : {}),
        ...(scope === 'listed_tests' ? { orderable_ids: plan.ids } : {}),
      };
      const r = await bulkUpdateDraftAction(versionId, body, key.current).catch(() => undefined);
      if (r?.ok) {
        key.current = undefined;
        toast.show({ tone: 'success', title: `${r.data.changed_count} ${k('bulk.done')}` });
        onClose();
        router.refresh();
      } else {
        if (r && r.status < 500) key.current = undefined; // a 5xx retry reuses the key: never a second change
        setFail(r?.detail ?? k('bulk.failed'));
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const n = plan.changed.length;
  const head = [k('bulk.code'), k('bulk.current'), k('bulk.new'), k('bulk.change')];
  const emptyText = !change ? k('bulk.preview_empty') : k('bulk.none_change');
  return (
    <Dialog title={k('bulk.button')} isOpen onClose={onClose} size="lg"
      footer={<>
        <Button variant="ghost" onPress={onClose}>{k('cancel')}</Button>
        <Button variant="primary" isDisabled={!canApply} isLoading={busy} onPress={() => void apply()}>{k('bulk.apply')}</Button>
      </>}>
      <div className="lims-stack">
        <RadioGroup<Kind> label={k('bulk.change')} name="change_kind" orientation="horizontal" value={kind} onChange={setKind}
          options={[{ value: 'percent', label: k('bulk.by_percent') }, { value: 'fixed_amount', label: k('bulk.by_amount') }]} />
        {kind === 'percent' ? (
          <TextField label={k('bulk.percent')} name="percent" maxLength={8} inputMode="decimal" value={percent} onChange={setPercent} {...(text.trim() && parsed === undefined ? { error: k('percent_invalid') } : {})} />
        ) : (
          <TextField label={k('bulk.amount')} name="amount" maxLength={11} inputMode="decimal" value={amount} onChange={setAmount} {...(text.trim() && parsed === undefined ? { error: k('amount_invalid') } : {})} />
        )}
        <RadioGroup<Rounding> label={k('rounding')} name="rounding" orientation="horizontal" value={rounding} onChange={setRounding}
          options={ROUNDINGS.map((value) => ({ value, label: k(`rounding.${value}`) }))} />
        <RadioGroup<Scope> label={k('bulk.scope')} name="scope" orientation="horizontal" value={scope} onChange={setScope}
          options={[{ value: 'all', label: k('bulk.scope_all') }, { value: 'department', label: k('bulk.scope_department') }, { value: 'listed_tests', label: k('bulk.scope_listed') }]} />
        {scope === 'department' ? (
          <Select<string> label={k('bulk.department')} name="department" {...(dept ? { value: dept } : {})} onChange={setDept} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
        ) : null}
        {scope === 'listed_tests' ? <TextField label={k('bulk.codes')} name="codes" maxLength={4000} description={k('bulk.codes_hint')} value={codes} onChange={setCodes} /> : null}
        {plan.scopeError && change ? <p className="lims-error">{plan.scopeError}</p> : null}
        {plan.negative.length ? <Alert text={`${k('bulk.below_zero')} ${plan.negative.map((r) => r.code).join(', ')}`} /> : null}
        {change && !plan.scopeError && !plan.negative.length ? (
          <p role="status">
            {n === 0 ? k('bulk.none_change') : `${n} ${k(n === 1 ? 'bulk.count_one' : 'bulk.count_many')}`}
            {n > PREVIEW_MAX ? ` · ${k('bulk.showing')} ${n}` : ''}
          </p>
        ) : null}
        {/* T0D-UIX-2 (LD-442): kit DataTable; the caption stays visible above it */}
        <p aria-hidden="true">{k('bulk.preview')}</p>
        <DataTable<BulkRow & { next: number }>
          caption={k('bulk.preview')}
          density="compact"
          rows={plan.changed.slice(0, PREVIEW_MAX)}
          getRowId={(r) => r.id}
          emptyState={{ title: emptyText }}
          columns={[
            { id: 'code', header: head[0]!, isRowHeader: true, cell: (r) => r.code },
            { id: 'current', header: head[1]!, numeric: true, cell: (r) => fmt2(r.paisa) },
            { id: 'next', header: head[2]!, numeric: true, cell: (r) => fmt2(r.next) },
            { id: 'change', header: head[3]!, numeric: true, cell: (r) => `${r.next > r.paisa ? '+' : ''}${fmt2(r.next - r.paisa)}` },
          ]}
        />
        {fail ? <Alert text={fail} /> : null}
      </div>
    </Dialog>
  );
}

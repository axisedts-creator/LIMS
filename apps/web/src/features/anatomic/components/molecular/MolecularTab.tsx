'use client';
// 04-UI-UX §4.2.6 Molecular tab: one editable row per assay target (Assay, Target, Result, Value, Unit, Method, Kit name, Kit lot, Kit expiry, Batch, Comment);
// [Add row] [Remove row] [Save] (Alt+S) = full replace with If-Match "<molecular_rev>" (AC-11.1). Pickers follow the assay definition (AC-11.2): Target lists the
// assay's active targets, Result exactly the target's active result values, Value exists only for a target with allows_quantitative and is sent as text (AC-11.3).
// Result values flagged is_abnormal carry the word "Abnormal" (never colour only). Read-only without anatomic.case.work, on a cancelled case, and on a signed-out
// case without an open revision/amendment draft (D-66 (b): the API would answer anatomic.signout_locked). Server text is rendered as text, never HTML (REQ-SEC-088).
// AC-11.6: a case without results cannot be marked ready; the 409 is shown by the case shell and this tab says why while it is empty.
// LD-140 (2026-11-13, binding): kit components and token class names only — no hex colours, pixel radii or inline style objects; the stage button of the case shell is
// the page's one primary button (Save is secondary); every status shows tone, icon and word.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { IconButton } from '@lims/ui/components/IconButton';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { listAssaysAction, listBatchesAction, saveMolecularResultsAction } from '../../server/actions.molecular';
import type { ActionResult, Assay, Batch, CaseDetail, MolecularInput, MolecularResult } from '../../server/types';
import { Chip, newKey, When, type Fail } from '../common';
import './molecular.css';

const MAX_ROWS = 50; // contract: results maxItems 50
const MIN_EXPIRY = '2000-01-01' as IsoDate; // 04-UI-UX §4.2.6: Kit expiry >= 2000-01-01
const COLUMNS = ['Assay', 'Target', 'Result', 'Value', 'Unit', 'Method', 'Kit name', 'Kit lot', 'Kit expiry', 'Batch', 'Comment'] as const;
const EMPTY = 'No results yet. Add a row for each assay target.';
const REQUIRED = 'Required';
const CHECK = 'Check this value.';
/** API error pointer property → editable field. */
const FIELD: Record<string, string> = {
  assay_code: 'assay', target_code: 'target', result_code: 'result', value_decimal: 'value', unit_code: 'value', method_text: 'method', kit_name: 'kitName', kit_lot: 'kitLot',
  kit_expiry_on: 'kitExpiry', batch_id: 'batchId', comment_text: 'comment',
};

interface Row {
  key: string;
  assay?: string | undefined;
  target?: string | undefined;
  result?: string | undefined;
  value?: string | undefined;
  unit?: string | undefined;
  abnormal?: boolean | undefined;
  method: string;
  kitName: string;
  kitLot: string;
  kitExpiry?: IsoDate | undefined;
  batchId?: string | undefined;
  comment: string;
  /** Display names the API saved with the result: shown while the assay list is loading or when the assay has since been retired. */
  seen?: { assay: string; target: string; result: string; batch?: string };
}
type Errors = Record<number, Record<string, string>>;
type Option = { value: string; label: string };

const fromResult = (r: MolecularResult): Row => ({
  key: r.id,
  assay: r.assay_code, target: r.target_code, result: r.result_code,
  ...(r.value_decimal !== undefined ? { value: r.value_decimal } : {}),
  ...(r.unit_code ? { unit: r.unit_code } : {}),
  abnormal: r.is_abnormal,
  method: r.method_text ?? '', kitName: r.kit_name ?? '', kitLot: r.kit_lot ?? '',
  ...(r.kit_expiry_on ? { kitExpiry: r.kit_expiry_on as IsoDate } : {}),
  ...(r.batch_id ? { batchId: r.batch_id } : {}),
  comment: r.comment_text ?? '',
  seen: { assay: r.assay_display, target: r.target_display, result: r.result_display, ...(r.batch_no ? { batch: r.batch_no } : {}) },
});

/** Only the contract's keys; empty optionals are omitted. The unit travels with a value only. */
const toInput = (r: Row, assays: readonly Assay[]): MolecularInput => {
  const target = assays.find((a) => a.code === r.assay)?.targets.find((t) => t.code === r.target);
  const quantitative = target ? target.allows_quantitative : r.value !== undefined;
  const value = quantitative && r.value ? r.value : undefined;
  return {
    assay_code: r.assay!, target_code: r.target!, result_code: r.result!,
    ...(value ? { value_decimal: value, ...(r.unit ? { unit_code: r.unit } : {}) } : {}),
    ...(r.method ? { method_text: r.method } : {}),
    ...(r.kitName ? { kit_name: r.kitName } : {}),
    ...(r.kitLot ? { kit_lot: r.kitLot } : {}),
    ...(r.kitExpiry ? { kit_expiry_on: r.kitExpiry } : {}),
    ...(r.batchId ? { batch_id: r.batchId } : {}),
    ...(r.comment ? { comment_text: r.comment } : {}),
  };
};

/** `/results/0/result_code` → { 0: { result: 'Check this value.' } }. The API's own message is never shown. */
const fieldErrors = (errors: readonly { path?: string }[] | undefined): Errors => {
  const out: Errors = {};
  for (const e of errors ?? []) {
    const m = /^\/results\/(\d+)\/([a-z_]+)$/.exec(e.path ?? '');
    const field = m && FIELD[m[2]!];
    if (m && field) (out[Number(m[1])] ??= {})[field] = CHECK;
  }
  return out;
};

const withSeen = (options: Option[], value: string | undefined, label: string | undefined): Option[] => (value && !options.some((o) => o.value === value) ? [...options, { value, label: label ?? value }] : options);

interface Props { detail: CaseDetail; canWork: boolean; onFail: (f: Fail) => void; onMfa: () => void }

function Grid({ children, readOnly }: { children: ReactNode; readOnly?: boolean }) {
  return (
    <div className="lims-molecular-scroll">
      <table role="grid" aria-label="Molecular results" {...(readOnly ? { 'aria-readonly': true } : {})} className="lims-table lims-table-compact">
        <thead>
          <tr role="row">
            {COLUMNS.map((c) => <th key={c} role="columnheader" scope="col">{c}</th>)}
            <th role="columnheader" scope="col"><VisuallyHidden>Actions</VisuallyHidden></th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const Cell = ({ children }: { children?: ReactNode }) => <td role="gridcell" className="lims-molecular-cell">{children}</td>;
const Abnormal = () => <Chip size="sm" tone="warning" label="Abnormal" />;

function ReadOnly({ results }: { results: readonly MolecularResult[] }) {
  if (results.length === 0) return <EmptyState title="No results recorded." />;
  return (
    <Grid readOnly>
      {results.map((r) => (
        <tr key={r.id} role="row">
          <Cell>{r.assay_display}</Cell>
          <Cell>{r.target_display}</Cell>
          <Cell>{r.result_display} {r.is_abnormal ? <Abnormal /> : null}</Cell>
          <Cell>{r.value_decimal ?? '—'}</Cell>
          <Cell>{r.unit_code ?? '—'}</Cell>
          <Cell>{r.method_text ?? '—'}</Cell>
          <Cell>{r.kit_name ?? '—'}</Cell>
          <Cell>{r.kit_lot ?? '—'}</Cell>
          <Cell><When value={r.kit_expiry_on} /></Cell>
          <Cell>{r.batch_no ?? '—'}</Cell>
          <Cell>{r.comment_text ?? '—'}</Cell>
          <Cell />
        </tr>
      ))}
    </Grid>
  );
}

interface RowProps { n: number; row: Row; assays: readonly Assay[]; batches: readonly Batch[]; errors: Record<string, string> | undefined; onChange: (patch: Partial<Row>) => void; onRemove: () => void }

function EditRow({ n, row, assays, batches, errors, onChange, onRemove }: RowProps) {
  const assayDef = assays.find((a) => a.code === row.assay);
  const targetDef = assayDef?.targets.find((t) => t.code === row.target);
  const valueDef = targetDef?.result_values.find((v) => v.code === row.result);
  const quantitative = targetDef ? targetDef.allows_quantitative : row.value !== undefined;
  const abnormal = valueDef ? valueDef.is_abnormal : row.abnormal;
  const id = (f: string) => `${f}_${row.key}`;

  const assayOptions = withSeen(assays.filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.display })), row.assay, row.seen?.assay);
  const targetOptions = withSeen((assayDef?.targets ?? []).filter((t) => t.is_active).map((t) => ({ value: t.code, label: t.display })), row.target, row.seen?.target);
  const resultOptions = withSeen((targetDef?.result_values ?? []).filter((v) => v.is_active).map((v) => ({ value: v.code, label: v.display })), row.result, row.seen?.result);
  const batchOptions = withSeen(
    batches.filter((b) => b.assay_code === row.assay).map((b) => ({ value: b.id, label: `${b.batch_no} · ${b.status === 'open' ? 'Open' : 'Closed'}` })),
    row.batchId, row.seen?.batch,
  );

  const pickAssay = (code: string) => {
    const def = assays.find((a) => a.code === code);
    // Target, Result, Value, Unit and Batch belong to the assay: none of them may survive a change (no stale code is sent).
    onChange({ assay: code, target: undefined, result: undefined, value: undefined, unit: undefined, abnormal: undefined, batchId: undefined, method: def?.method_text_default ?? '' });
  };
  const pickTarget = (code: string) => {
    const t = assayDef?.targets.find((x) => x.code === code);
    onChange({ target: code, result: undefined, value: undefined, abnormal: undefined, unit: t?.allows_quantitative ? t.unit_code : undefined });
  };

  return (
    <tr role="row">
      <Cell><Select key={`a-${row.key}`} label="Assay" name={id('assay')} isRequired options={assayOptions} {...(row.assay ? { value: row.assay } : {})} {...(errors?.['assay'] ? { error: errors['assay'] } : {})} onChange={pickAssay} /></Cell>
      <Cell>
        <Select
          key={`t-${row.key}-${row.assay ?? ''}`} label="Target" name={id('target')} isRequired isDisabled={!row.assay} options={targetOptions}
          {...(row.target ? { value: row.target } : {})} {...(errors?.['target'] ? { error: errors['target'] } : {})} onChange={pickTarget}
        />
      </Cell>
      <Cell>
        <Select
          key={`r-${row.key}-${row.assay ?? ''}-${row.target ?? ''}`} label="Result" name={id('result')} isRequired isDisabled={!row.target} options={resultOptions}
          {...(row.result ? { value: row.result } : {})} {...(errors?.['result'] ? { error: errors['result'] } : {})} onChange={(code) => onChange({ result: code, abnormal: targetDef?.result_values.find((v) => v.code === code)?.is_abnormal })}
        />
        {abnormal ? <Abnormal /> : null}
      </Cell>
      <Cell>
        {quantitative ? (
          <DecimalField label="Value" name={id('value')} decimals={targetDef?.decimals ?? 6} {...(row.value !== undefined ? { value: row.value } : {})} {...(errors?.['value'] ? { error: errors['value'] } : {})} onChange={(v) => onChange({ value: v })} />
        ) : (
          '—'
        )}
      </Cell>
      <Cell>{quantitative && row.unit ? row.unit : '—'}</Cell>
      <Cell><TextField label="Method" name={id('method')} maxLength={200} value={row.method} {...(errors?.['method'] ? { error: errors['method'] } : {})} onChange={(v) => onChange({ method: v })} /></Cell>
      <Cell><TextField label="Kit name" name={id('kit_name')} maxLength={120} value={row.kitName} {...(errors?.['kitName'] ? { error: errors['kitName'] } : {})} onChange={(v) => onChange({ kitName: v })} /></Cell>
      <Cell><TextField label="Kit lot" name={id('kit_lot')} maxLength={64} value={row.kitLot} {...(errors?.['kitLot'] ? { error: errors['kitLot'] } : {})} onChange={(v) => onChange({ kitLot: v })} /></Cell>
      <Cell><DatePicker label="Kit expiry" name={id('kit_expiry')} min={MIN_EXPIRY} {...(row.kitExpiry ? { value: row.kitExpiry } : {})} {...(errors?.['kitExpiry'] ? { error: errors['kitExpiry'] } : {})} onChange={(v) => onChange(v ? { kitExpiry: v } : { kitExpiry: undefined })} /></Cell>
      <Cell>
        <Select
          key={`b-${row.key}-${row.assay ?? ''}`} label="Batch" name={id('batch')} isDisabled={!row.assay} options={batchOptions}
          {...(row.batchId ? { value: row.batchId } : {})} {...(errors?.['batchId'] ? { error: errors['batchId'] } : {})} onChange={(v) => onChange({ batchId: v })}
        />
      </Cell>
      <Cell><TextField label="Comment" name={id('comment')} maxLength={1000} value={row.comment} {...(errors?.['comment'] ? { error: errors['comment'] } : {})} onChange={(v) => onChange({ comment: v })} /></Cell>
      <Cell><IconButton label={`Remove row ${n}`} icon="close" onPress={onRemove} /></Cell>
    </tr>
  );
}

function Editor({ detail, onFail, onMfa }: Omit<Props, 'canWork'>) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>(() => (detail.molecular_results ?? []).map(fromResult));
  const [rev, setRev] = useState(detail.molecular_rev);
  const [assays, setAssays] = useState<readonly Assay[]>([]);
  const [batches, setBatches] = useState<readonly Batch[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const busy = useRef(false);
  const dirtyRef = useRef(false);
  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };

  // A failing picker list leaves the pickers empty; it never breaks the tab (the saved rows still show their own display names).
  useEffect(() => {
    let live = true;
    const ok = <T,>(r: ActionResult<T>, set: (v: T) => void) => live && r.ok && set(r.data);
    listAssaysAction().then((r) => ok(r, setAssays), () => undefined);
    listBatchesAction().then((r) => ok(r, setBatches), () => undefined);
    return () => { live = false; };
  }, []);

  const patch = (key: string, p: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
    setErrors({});
    setDirty(true);
  };

  const validate = (): Errors => {
    const out: Errors = {};
    rows.forEach((r, i) => {
      const e: Record<string, string> = {};
      if (!r.assay) e['assay'] = REQUIRED;
      if (!r.target) e['target'] = REQUIRED;
      if (!r.result) e['result'] = REQUIRED;
      if (Object.keys(e).length) out[i] = e;
    });
    return out;
  };

  const save = async () => {
    if (busy.current || !dirtyRef.current) return; // one request per press; nothing changed since the last save = nothing to send
    const bad = validate();
    setErrors(bad);
    if (Object.keys(bad).length) return;
    busy.current = true;
    setPending(true);
    try {
      const r = await saveMolecularResultsAction(detail.id, rev, rows.map((x) => toInput(x, assays)));
      if (r.ok) {
        setRev(r.data.molecular_rev);
        setRows(r.data.results.map(fromResult));
        setDirty(false);
        toast.show({ tone: 'success', title: 'Molecular results saved' });
        router.refresh();
      } else if (r.code === 'auth.mfa_required') onMfa();
      else {
        if (r.code === 'common.validation_failed') setErrors(fieldErrors(r.errors));
        onFail(r);
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    // data-testid is how the case shell's Alt+S finds the form to submit.
    <form data-testid="molecular-form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Grid>
        {rows.map((r, i) => (
          <EditRow
            key={r.key} n={i + 1} row={r} assays={assays} batches={batches} errors={errors[i]}
            onChange={(p) => patch(r.key, p)} onRemove={() => { setRows((rs) => rs.filter((x) => x.key !== r.key)); setErrors({}); setDirty(true); }}
          />
        ))}
      </Grid>
      {rows.length === 0 ? <EmptyState title={EMPTY} /> : null}
      <div className="lims-molecular-actions">
        <Button iconStart="plus" isDisabled={rows.length >= MAX_ROWS} onPress={() => { setRows((rs) => [...rs, { key: newKey(), method: '', kitName: '', kitLot: '', comment: '' }]); setDirty(true); }}>Add row</Button>
        <Button type="submit" isLoading={pending} isDisabled={!dirty} shortcut="Alt+S">Save</Button>
      </div>
    </form>
  );
}

export function MolecularTab({ detail, canWork, onFail, onMfa }: Props) {
  const drafting = detail.open_draft !== undefined && detail.open_draft.kind !== 'initial';
  const editable = canWork && detail.status !== 'cancelled' && (detail.status !== 'signed_out' || drafting);
  // Remounted when a refresh brings a new molecular_rev: the rows then come from the server, and a "Reload" after a conflict drops the stale edits.
  return editable ? <Editor key={detail.molecular_rev} detail={detail} onFail={onFail} onMfa={onMfa} /> : <ReadOnly results={detail.molecular_results ?? []} />;
}

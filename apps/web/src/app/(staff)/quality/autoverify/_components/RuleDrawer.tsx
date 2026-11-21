'use client';
// 04-UI-UX §2.8 rule form in a Drawer; Save sends the WHOLE definition through #39 (AC-10.1). LD-140: @lims/ui only, per-section Save, no inline styles.
// Client checks mirror the DSL (AC-10.2) so a bad rule never leaves the browser; the API validates again and its errors[] are shown by rule.
import { useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Drawer, DrawerSection } from '@lims/ui/components/Drawer';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { saveDraftAction } from '../_lib/actions';
import { DECIMAL, RULE_KEY, UUID, cmpDecimal } from '../_lib/format';
import type { RangeFlag, Rule } from '../_lib/types';
import { NoticeBanner, useWrite } from './shared';

const FLAGS: { flag: RangeFlag; label: string }[] = [{ flag: 'N', label: 'N (Normal)' }, { flag: 'L', label: 'L (Low)' }, { flag: 'H', label: 'H (High)' }];
const MAX_FLAGS = 20;
const MAX_FLAG_LEN = 16;

interface Form {
  key: string; test_id: string; analyte_id: string; instrument_id: string; enabled: boolean; low: string; high: string;
  flags: RangeFlag[]; ignored: string[]; qcWarn: boolean; note: string;
}
type Errors = Partial<Record<'key' | 'test_id' | 'analyte_id' | 'instrument_id' | 'low' | 'high' | 'flags', string>>;

const toForm = (r: Rule | undefined, key: string): Form => ({
  key: r?.key ?? key, test_id: r?.test_id ?? '', analyte_id: r?.analyte_id ?? '', instrument_id: r?.instrument_id ?? '', enabled: r?.enabled ?? true,
  low: r?.limits?.low ?? '', high: r?.limits?.high ?? '', flags: r?.allowed_range_flags ?? ['N'], ignored: r?.instrument_flags_allowed ?? [], qcWarn: r?.qc_allow_warning ?? false, note: r?.note ?? '',
});

function toRule(f: Form): Rule {
  const low = f.low.trim();
  const high = f.high.trim();
  const note = f.note.trim();
  return {
    key: f.key, test_id: f.test_id.trim(), analyte_id: f.analyte_id.trim(), ...(f.instrument_id.trim() ? { instrument_id: f.instrument_id.trim() } : {}), enabled: f.enabled,
    limits: { ...(low ? { low } : {}), ...(high ? { high } : {}) },
    allowed_range_flags: FLAGS.map((x) => x.flag).filter((x) => f.flags.includes(x)),
    instrument_flags_allowed: f.ignored, qc_allow_warning: f.qcWarn, ...(note ? { note } : {}),
  };
}

function validate(f: Form, others: Rule[]): Errors {
  const e: Errors = {};
  if (!RULE_KEY.test(f.key)) e.key = 'Use 1 to 40 letters, digits, "_" or "-" and no spaces.';
  else if (others.some((r) => r.key === f.key)) e.key = 'Another rule already uses this key.';
  if (!UUID.test(f.test_id.trim())) e.test_id = 'Enter the test id.';
  if (!UUID.test(f.analyte_id.trim())) e.analyte_id = 'Enter the analyte id.';
  const inst = f.instrument_id.trim();
  if (inst && !UUID.test(inst)) e.instrument_id = 'Enter an instrument id, or leave it empty for any instrument.';
  else if (!e.analyte_id && others.some((r) => r.analyte_id === f.analyte_id.trim() && (r.instrument_id ?? '') === inst)) e.instrument_id = 'Another rule already covers this analyte on this instrument.';
  const [low, high] = [f.low.trim(), f.high.trim()];
  if (!low && !high) e.low = 'Enter at least one limit.';
  if (low && !DECIMAL.test(low)) e.low = 'Use a plain number such as 3.5 (no exponent).';
  if (high && !DECIMAL.test(high)) e.high = 'Use a plain number such as 5.1 (no exponent).';
  if (!e.low && !e.high && low && high && cmpDecimal(low, high) > 0) e.low = 'The lower limit must not be above the upper limit.';
  if (!f.flags.length) e.flags = 'Choose at least one range flag.';
  return e;
}

/** `index` -1 = a new rule. The drawer owns its form; the parent mounts it only while it is open. */
export function RuleDrawer({ rules, index, versionId, version, onClose }: { rules: Rule[]; index: number; versionId: string; version: number; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const w = useWrite();
  const editing = index >= 0 ? rules[index] : undefined;
  const others = rules.filter((_, i) => i !== index);
  const [f, setF] = useState<Form>(() => {
    let n = rules.length + 1;
    while (rules.some((r) => r.key === `R${n}`)) n += 1;
    return toForm(editing, `R${n}`);
  });
  const [errors, setErrors] = useState<Errors>({});
  const [draft, setDraft] = useState('');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const addFlag = (raw: string) => {
    const v = raw.trim();
    if (v && v.length <= MAX_FLAG_LEN && f.ignored.length < MAX_FLAGS && !f.ignored.includes(v)) set('ignored', [...f.ignored, v]);
    setDraft('');
  };
  const onFlagKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addFlag((e.target as HTMLInputElement).value);
  };

  const save = async () => {
    const found = validate(f, others);
    setErrors(found);
    if (Object.keys(found).length) return;
    const next = rules.map((r, i) => (i === index ? toRule(f) : r));
    if (index < 0) next.push(toRule(f));
    const definition = { schema_version: 1 as const, rules: next };
    await w.run('save', JSON.stringify(definition), () => saveDraftAction(versionId, version, definition), () => {
      toast.show({ tone: 'success', title: 'Rule saved' });
      onClose();
      router.refresh();
    });
  };

  const rowName = (path: string) => {
    const m = /\/rules\/(\d+)/.exec(path);
    const at = m ? Number(m[1]) : -1;
    return at >= 0 && at < rules.length ? `Rule ${rules[at]?.key ?? at + 1}` : index < 0 ? 'New rule' : 'Rule';
  };

  return (
    <Drawer title={index < 0 ? 'Add rule' : `Edit rule ${editing?.key ?? ''}`} isOpen onClose={onClose} width="md">
      <NoticeBanner notice={w.notice} onReload={() => router.refresh()} />
      {/* T0D-UIGUARD-1-QUALITY (LD-436 R7): no raw ul; the items keep list semantics. */}
      {w.notice?.errors?.length ? <div role="list">{w.notice.errors.map((x, i) => <div role="listitem" key={i}>{rowName(x.path)}: {x.message}</div>)}</div> : null}
      <DrawerSection title="Rule" onSave={() => void save()} isSaving={w.pending}>
        <TextField label="Key" name="key" maxLength={40} isRequired value={f.key} onChange={(v) => set('key', v)} {...(errors.key ? { error: errors.key } : {})} />
        <TextField label="Test" name="test_id" maxLength={36} isRequired isReadOnly={!!editing} value={f.test_id} onChange={(v) => set('test_id', v)} {...(errors.test_id ? { error: errors.test_id } : {})} />
        <TextField label="Analyte" name="analyte_id" maxLength={36} isRequired isReadOnly={!!editing} value={f.analyte_id} onChange={(v) => set('analyte_id', v)} {...(errors.analyte_id ? { error: errors.analyte_id } : {})} />
        <TextField
          label="Instrument" name="instrument_id" maxLength={36} isReadOnly={!!editing} value={f.instrument_id} onChange={(v) => set('instrument_id', v)}
          description="Any instrument when left empty." {...(errors.instrument_id ? { error: errors.instrument_id } : {})}
        />
        <Switch label="Enabled" isSelected={f.enabled} onChange={(v) => set('enabled', v)} />
        {f.enabled ? null : <p className="lims-description">Never auto-verify this analyte on this instrument.</p>}
        <TextField label="Lower limit" name="low" maxLength={40} value={f.low} onChange={(v) => set('low', v)} {...(errors.low ? { error: errors.low } : {})} />
        <TextField label="Upper limit" name="high" maxLength={40} value={f.high} onChange={(v) => set('high', v)} {...(errors.high ? { error: errors.high } : {})} />
        <fieldset className="lims-field">
          <legend className="lims-label">Allowed range flags</legend>
          {FLAGS.map(({ flag, label }) => (
            <Checkbox key={flag} label={label} isSelected={f.flags.includes(flag)} onChange={(on) => set('flags', on ? [...f.flags, flag] : f.flags.filter((x) => x !== flag))} />
          ))}
          {errors.flags ? <p role="alert" className="lims-error">{errors.flags}</p> : null}
        </fieldset>
        <Switch label="Allow when QC shows a warning" isSelected={f.qcWarn} onChange={(v) => set('qcWarn', v)} />
        <div onKeyDownCapture={onFlagKey}>
          <TextField label="Instrument flags to ignore" name="ignored" maxLength={MAX_FLAG_LEN} value={draft} onChange={setDraft} description="Type a flag and press Enter. Up to 20 flags, 16 characters each." />
        </div>
        {f.ignored.length ? (
          <div role="list">
            {f.ignored.map((x) => (
              <div role="listitem" key={x}>{x} <Button size="sm" variant="ghost" onPress={() => set('ignored', f.ignored.filter((y) => y !== x))}>Remove<VisuallyHidden> {x}</VisuallyHidden></Button></div>
            ))}
          </div>
        ) : null}
        <TextField label="Note" name="note" maxLength={200} value={f.note} onChange={(v) => set('note', v)} />
      </DrawerSection>
    </Drawer>
  );
}

'use client';
// SR-04 "Settings & score" (04-UI-UX table): PATCH #4 with If-Match. bp fields are edited as % (bp / 100) and sent back as % x 100.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Form, type ProblemLike } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { patchVersionAction } from '../server/actions';
import type { Version } from '../library';
import { ErrorAlert, useEditor } from './common';

type NumKey = { key: string; label: string; min: number; max: number; bp?: true; help?: string };
const CREDITS: NumKey[] = [
  { key: 'credit_in_range_bp', label: 'Credit: in range', min: 0, max: 100, bp: true },
  { key: 'credit_borderline_bp', label: 'Credit: borderline', min: 0, max: 100, bp: true },
  { key: 'credit_out_of_range_bp', label: 'Credit: out of range', min: 0, max: 100, bp: true },
  { key: 'credit_critical_bp', label: 'Credit: critical', min: 0, max: 100, bp: true },
];
const SCORE: NumKey[] = [
  { key: 'min_groups_scored', label: 'Minimum body systems for a score', min: 1, max: 20 },
  { key: 'band_good_min', label: '"Good" from', min: 1, max: 100 },
  { key: 'band_fair_min', label: '"Fair" from', min: 0, max: 99 },
];
const MORE: NumKey[] = [
  { key: 'borderline_fraction_bp', label: 'Borderline margin (% of range width)', min: 0, max: 25, bp: true, help: '0 means no borderline band.' },
  { key: 'min_mapped_results', label: 'Minimum mapped results per order', min: 1, max: 50 },
];
const TRENDS: NumKey[] = [
  { key: 'trend_max_points', label: 'Max points', min: 2, max: 6 },
  { key: 'trend_lookback_days', label: 'Look-back days', min: 30, max: 3650 },
  { key: 'trend_stable_bp', label: 'Stable change (%)', min: 0, max: 50, bp: true },
  { key: 'trends_max', label: 'Max trends', min: 0, max: 12 },
];
const LIMITS: NumKey[] = [
  { key: 'advice_max_blocks', label: 'Max advice blocks', min: 0, max: 10 },
  { key: 'followup_max', label: 'Max follow-up suggestions', min: 0, max: 5 },
];
const NUMS = [...CREDITS, ...SCORE, ...MORE, ...TRENDS, ...LIMITS];
const BOOLS = ['score_enabled', 'critical_forces_needs_attention', 'trend_enabled'];
const name = (k: string) => `params/${k}`;

export function SettingsTab({ version }: { version: Version }) {
  const ed = useEditor();
  const ro = ed.readOnly;
  const p = version.params ?? {};
  const [language, setLanguage] = useState<'en' | 'ne'>(version.language === 'ne' ? 'ne' : 'en');
  const [summary, setSummary] = useState(version.change_summary ?? '');
  const [nums, setNums] = useState<Record<string, number | undefined>>(() =>
    Object.fromEntries(NUMS.map((n) => { const v = p[n.key]; return [n.key, typeof v === 'number' ? (n.bp ? v / 100 : v) : undefined]; })));
  const [bools, setBools] = useState<Record<string, boolean>>(() => Object.fromEntries(BOOLS.map((k) => [k, p[k] !== false])));
  const [rowVersion, setRowVersion] = useState(version.version);
  const [problem, setProblem] = useState<ProblemLike>();
  const [alert, setAlert] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  // focus the first field a check or the server named
  useEffect(() => {
    const first = problem?.errors?.[0]?.path?.replace(/^\//, '');
    if (first) box.current?.querySelector<HTMLElement>(`[name="${CSS.escape(first)}"]`)?.focus();
  }, [problem]);

  const num = (n: NumKey) => {
    const v = nums[n.key];
    return (
      <IntegerField
        key={n.key} label={n.label} name={name(n.key)} min={n.min} max={n.max} isReadOnly={ro} {...(n.help ? { description: n.help } : {})}
        {...(v !== undefined ? { value: v } : {})} onChange={(x) => setNums((s) => ({ ...s, [n.key]: x }))}
      />
    );
  };
  const sw = (k: string, label: string) => <Switch label={label} isSelected={!!bools[k]} isDisabled={ro} onChange={(v) => setBools((s) => ({ ...s, [k]: v }))} />;

  const crossChecks = () => {
    const errs: { path: string; message: string }[] = [];
    const c = CREDITS.map((x) => nums[x.key] ?? 0);
    for (let i = 1; i < c.length; i++) {
      if (c[i]! > c[i - 1]!) errs.push({ path: `/${name(CREDITS[i]!.key)}`, message: `${CREDITS[i]!.label} must not be higher than ${CREDITS[i - 1]!.label.replace('Credit: ', '')}.` });
    }
    if ((nums['band_fair_min'] ?? 0) >= (nums['band_good_min'] ?? 0)) errs.push({ path: `/${name('band_fair_min')}`, message: '"Fair" from must be lower than "Good" from.' });
    return errs;
  };

  const submit = async () => {
    setAlert(undefined);
    const errs = crossChecks();
    if (errs.length) { setProblem({ errors: errs }); return; }
    setProblem(undefined);
    const params: Record<string, number | boolean> = { ...bools };
    for (const n of NUMS) { const v = nums[n.key]; if (v !== undefined) params[n.key] = n.bp ? Math.round(v * 100) : v; }
    const r = await patchVersionAction(ed.versionId, rowVersion, { language, change_summary: summary, params });
    if (r.ok) { setRowVersion(r.data.version); ed.saved(); return; }
    const text = ed.failed(r);
    if (r.errors?.length) setProblem({ errors: r.errors.map((e) => ({ path: e.path, message: e.message })) });
    else if (r.code !== 'smartreport.library_invalid_transition') setAlert(text);
  };

  return (
    <div ref={box}>
      <ErrorAlert text={alert} />
      <Form onSubmit={submit} {...(problem ? { problem } : {})}>
        <RadioGroup label="Language" name="language" orientation="horizontal" isDisabled={ro} value={language} onChange={setLanguage} options={[{ value: 'en', label: 'English' }, { value: 'ne', label: 'Nepali' }]} />
        <TextArea label="Change summary" name="change_summary" maxLength={500} isReadOnly={ro} value={summary} onChange={setSummary} />
        {sw('score_enabled', 'Show health score')}
        {CREDITS.map(num)}
        {SCORE.map(num)}
        <Checkbox label='Any critical result forces "Needs attention"' isDisabled={ro} isSelected={!!bools['critical_forces_needs_attention']} onChange={(v) => setBools((s) => ({ ...s, critical_forces_needs_attention: v }))} />
        {MORE.map(num)}
        {sw('trend_enabled', 'Trends enabled')}
        {TRENDS.map(num)}
        {LIMITS.map(num)}
        {ro ? null : <Button type="submit" variant="primary">Save</Button>}
      </Form>
      <Card title={`Health score formula ${version.formula_version ?? 'hs-1'}`}>
        <p>
          Formula hs-1: each shown body system gets the credit of its results (in range, borderline, out of range or critical); body systems are weighted; the score is shown only when
          enough body systems and mapped results are present; the band (Good, Fair, Needs attention) follows the thresholds above, and a critical result can force "Needs attention".
        </p>
      </Card>
    </div>
  );
}

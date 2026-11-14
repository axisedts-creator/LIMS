'use client';
// 04-UI-UX §2.11 Quality settings: kit Tabs "Settings" | "Coded sets"; cards TAT alerts / QC / Auto-verification / Read-only. LD-140: @lims/ui only; each editable card has its own
// Save (secondary: the page has no primary action); the PUT (#52) always carries the full set of nine mutable keys, the other cards' values being the stored ones.
import { useState, type ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { FormMessage, useSetupAction } from '../forms/fields';
import { MODE } from '../format';
import type { QualityCode, QualitySettings } from '../types';
import { saveSettingsAction } from './actions';
import { CodedSetsView } from './CodedSetsView';
import { PLAN_WINDOWS } from '../forms/validate';
import { MEAN_RULES, RANGES, settingsBody, settingsValid, type CodedSetName, type NumKey } from './validate';

type Plan = Record<string, unknown>;
type Draft = { [K in NumKey]: number | undefined } & { tat_alerts_enabled: boolean; default_plan_params: Plan };
type Window = keyof typeof PLAN_WINDOWS;
// Labels as the plan form (forms/PlansView.tsx) so a default reads the same as the plan field it pre-fills.
const FLAGS = [['two_two_s_across_runs', '2-2s also across runs'], ['count_rules_across_materials', 'Count rules across levels'], ['exclude_rejected_runs_from_history', 'Ignore rejected runs in history']] as const;
const WINDOWS: [Window, string][] = [['run_window_minutes', 'Run window (minutes)'], ['qc_validity_hours', 'QC valid for (hours)'], ['hold_lookback_hours', 'Hold look-back (hours)']];
const TABS = [{ id: 'settings', label: 'Settings' }, { id: 'coded', label: 'Coded sets' }] as const;

export function SettingsView({ settings, sets, canManage }: { settings: QualitySettings; sets: Record<CodedSetName, QualityCode[]>; canManage: boolean }) {
  const [tab, setTab] = useState<string>('settings');
  const [draft, setDraft] = useState<Draft>(() => {
    const b = settingsBody(settings);
    return { tat_alerts_enabled: b.tat_alerts_enabled, tat_warn_pct: b.tat_warn_pct, tat_escalate_pct: b.tat_escalate_pct, tat_orphan_close_hours: b.tat_orphan_close_hours, target_min_points: b.target_min_points,
      sim_min_days: b.sim_min_days, sim_min_decisions: b.sim_min_decisions, reprocess_window_days: b.reprocess_window_days, default_plan_params: { ...b.default_plan_params } };
  });
  const num = (k: NumKey, label: string, description?: string) => (
    <IntegerField
      key={k} label={label} name={k} isRequired isReadOnly={!canManage} min={RANGES[k][0]} max={RANGES[k][1]}
      {...(draft[k] !== undefined ? { value: draft[k] } : {})} onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))} {...(description ? { description } : {})}
    />
  );
  const plan = draft.default_plan_params;
  const setPlan = (k: string, v: unknown) => setDraft((d) => ({ ...d, default_plan_params: { ...d.default_plan_params, [k]: v } }));
  const card = (title: string, keys: (keyof Draft)[], fields: ReactNode) => (
    <SettingsCard title={title} keys={keys} settings={settings} draft={draft} canManage={canManage}>{fields}</SettingsCard>
  );

  return (
    <>
      <PageHeader title="Quality settings" helpKey="quality.settings" />
      <Tabs items={TABS} selectedId={tab} aria-label="Settings sections" onChange={setTab}>
        {tab === 'settings' ? (
          <>
            {card('TAT alerts', ['tat_alerts_enabled', 'tat_warn_pct', 'tat_escalate_pct', 'tat_orphan_close_hours'], (
              <>
                <Switch label="Enabled" isSelected={draft.tat_alerts_enabled} isDisabled={!canManage} onChange={(on) => setDraft((d) => ({ ...d, tat_alerts_enabled: on }))} />
                {num('tat_warn_pct', 'Warning at %')}
                {num('tat_escalate_pct', 'Escalate at %')}
                {num('tat_orphan_close_hours', 'Close orphan clocks after h')}
              </>
            ))}
            {card('QC', ['target_min_points', 'reprocess_window_days', 'default_plan_params'], (
              <>
                {num('target_min_points', 'Minimum points to establish a target', 'Common practice is about 20; check your SOP.')}
                {num('reprocess_window_days', 'Re-process window days')}
                {/* 04-UI-UX §2.11 "default plan options" = QcPlanParamsDefaults; an unset key stays unset (server default) */}
                <Select<string>
                  label="n-x rule" name="mean_rule" isReadOnly={!canManage} options={MEAN_RULES.map((x) => ({ value: x, label: x }))}
                  {...(typeof plan['mean_rule'] === 'string' ? { value: plan['mean_rule'] } : {})} onChange={(v) => setPlan('mean_rule', v)}
                />
                {FLAGS.map(([k, label]) => (
                  <Switch key={k} label={label} isSelected={plan[k] !== false} isDisabled={!canManage} onChange={(on) => setPlan(k, on)} />
                ))}
                {WINDOWS.map(([k, label]) => (
                  <IntegerField
                    key={k} label={label} name={k} isReadOnly={!canManage} min={PLAN_WINDOWS[k][0]} max={PLAN_WINDOWS[k][1]}
                    {...(typeof plan[k] === 'number' ? { value: plan[k] as number } : {})} onChange={(v) => setPlan(k, v)}
                  />
                ))}
              </>
            ))}
            {card('Auto-verification', ['sim_min_days', 'sim_min_decisions'], (
              <>
                {num('sim_min_days', 'Minimum simulation days')}
                {num('sim_min_decisions', 'Minimum shadow decisions')}
              </>
            ))}
            <Card title="Read-only from tenant settings">
              <DescriptionList items={[{ term: 'Westgard mode', value: ` ${MODE[settings.westgard_mode] ?? settings.westgard_mode} ` }, { term: 'Auto-verification', value: settings.auto_verification_enabled ? ' On ' : ' Off ' }]} />
              <p className="lims-description">Change in Admin › Tenant settings</p>
            </Card>
          </>
        ) : (
          <CodedSetsView sets={sets} canManage={canManage} />
        )}
      </Tabs>
    </>
  );
}

/** One section: kit Form (required + range checks before anything is sent), one Save. Saves the stored values plus this card's edited ones. */
function SettingsCard({ title, keys, settings, draft, canManage, children }: { title: string; keys: (keyof Draft)[]; settings: QualitySettings; draft: Draft; canManage: boolean; children: ReactNode }) {
  const act = useSetupAction();
  const save = async () => {
    const body = { ...settingsBody(settings), ...Object.fromEntries(keys.map((k) => [k, draft[k]])) };
    if (!settingsValid(body)) return;
    await act.run(JSON.stringify(body), () => saveSettingsAction(settings.version, body), { ok: 'Settings saved' });
  };
  return (
    <Card title={title}>
      <Form onSubmit={save} errorSummary={false}>
        {children}
        <FormMessage text={act.general} />
        {canManage ? <Button type="submit" variant="secondary">Save</Button> : null}
      </Form>
    </Card>
  );
}

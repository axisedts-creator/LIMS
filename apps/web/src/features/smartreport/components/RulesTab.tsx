'use client';
// SR-04 "Rules" (#9–#12): sub-tabs Findings / Advice / Follow-up; fixed info banner on Follow-up; Drawer editor (POST with Idempotency-Key, PUT/DELETE with If-Match).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Tabs } from '@lims/ui/components/Tabs';
import { removeAction, saveRuleAction } from '../server/actions';
import { FOLLOWUP_BANNER, newKey, type Block, type Option, type Rule, type RuleKind } from '../library';
import { ErrorAlert, byField, useEditor } from './common';

const SUBTABS = [{ id: 'deranged', label: 'Findings' }, { id: 'advice', label: 'Advice' }, { id: 'followup', label: 'Follow-up' }] as const;
const TRIGGER: Record<string, string> = { analyte: 'Analyte', group: 'Body system', any: 'Any finding', all_in_range: 'All in range' };
const DIRECTIONS = [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'abnormal', label: 'Abnormal' }, { value: 'any', label: 'Any' }];
const SEVERITIES = [{ value: 'borderline', label: 'Borderline' }, { value: 'out_of_range', label: 'Out of range' }, { value: 'critical', label: 'Critical' }];
const label = (list: Option[], v?: string) => list.find((o) => o.value === v)?.label ?? '—';

interface Props { rules: Rule[]; blocks: Block[]; groupName: (c?: string) => string; organGroups: Option[] }

export function RulesTab({ rules, blocks, groupName, organGroups }: Props) {
  const ed = useEditor();
  const router = useRouter();
  const [kind, setKind] = useState<RuleKind>('deranged');
  const [editing, setEditing] = useState<Rule | 'new'>();
  const [removing, setRemoving] = useState<Rule>();
  const [alert, setAlert] = useState<string>();
  const keyOf = (id: string) => blocks.find((b) => b.id === id)?.block_key ?? 'Text not found';

  const remove = async () => {
    if (!removing) return;
    const r = await removeAction(ed.versionId, 'rule', removing.id, removing.version);
    setRemoving(undefined);
    if (r.ok) { setAlert(undefined); router.refresh(); } else setAlert(ed.failed(r));
  };

  const columns: ColumnDef<Rule>[] = [
    { id: 'trigger', header: 'Trigger', isRowHeader: true, cell: (r) => (r.trigger_kind === 'group' ? `Body system: ${groupName(r.group_code)}` : TRIGGER[r.trigger_kind] ?? r.trigger_kind) },
    { id: 'direction', header: 'Direction', cell: (r) => label(DIRECTIONS, r.direction) },
    { id: 'severity', header: 'Minimum severity', cell: (r) => label(SEVERITIES, r.min_severity) },
    { id: 'priority', header: 'Priority', align: 'end', cell: (r) => String(r.priority ?? 100) },
    { id: 'text', header: 'Text', cell: (r) => keyOf(r.block_id) },
    ...(kind === 'followup' ? [{ id: 'interval', header: 'Interval', cell: (r: Rule) => (r.interval_days ? `${r.interval_days} days` : '—') }] : []),
    ...(ed.readOnly ? [] : [{
      id: 'actions', header: 'Actions',
      cell: (r: Rule) => (
        <span className="lims-inline">
          <Button size="sm" variant="ghost" onPress={() => setEditing(r)}>Edit</Button>
          <Button size="sm" variant="ghost" onPress={() => setRemoving(r)}>Remove</Button>
        </span>
      ),
    }]),
  ];

  return (
    <div>
      <ErrorAlert text={alert} />
      <Tabs items={SUBTABS} selectedId={kind} onChange={(k) => setKind(k as RuleKind)} aria-label="Rule kinds">
        {kind === 'followup' ? <Banner tone="info" title={FOLLOWUP_BANNER} /> : null}
        {ed.readOnly ? null : <Button variant="primary" onPress={() => setEditing('new')}>Add rule</Button>}
        <DataTable
          columns={columns} rows={rules.filter((r) => r.rule_kind === kind)} getRowId={(r) => r.id} density="compact"
          caption={`${SUBTABS.find((s) => s.id === kind)!.label} rules`} emptyState={{ title: 'No rules yet' }}
        />
      </Tabs>
      {editing ? (
        <RuleDrawer kind={kind} rule={editing === 'new' ? undefined : editing} blocks={blocks.filter((b) => b.kind === kind)} organGroups={organGroups} onClose={() => setEditing(undefined)} />
      ) : null}
      <ConfirmDialog
        title="Remove this rule?" body="The rule stops applying in this version. Earlier versions keep it." confirmLabel="Remove" tone="danger"
        isOpen={!!removing} onCancel={() => setRemoving(undefined)} onConfirm={remove}
      />
    </div>
  );
}

function RuleDrawer({ kind, rule, blocks, organGroups, onClose }: { kind: RuleKind; rule?: Rule | undefined; blocks: Block[]; organGroups: Option[]; onClose: () => void }) {
  const ed = useEditor();
  const [trigger, setTrigger] = useState<string | undefined>(rule?.trigger_kind);
  const [group, setGroup] = useState(rule?.group_code);
  const [direction, setDirection] = useState(rule?.direction);
  const [severity, setSeverity] = useState(rule?.min_severity);
  const [priority, setPriority] = useState<number | undefined>(rule?.priority ?? 100);
  const [blockId, setBlockId] = useState(rule?.block_id);
  const [interval, setIntervalDays] = useState<number | undefined>(rule?.interval_days); // AC-05.1: no default
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string>();
  const idem = useRef(newKey());
  const triggers = Object.entries(TRIGGER).filter(([k]) => k !== 'all_in_range' || kind === 'advice').map(([value, l]) => ({ value, label: l }));

  const save = async () => {
    const e: Record<string, string> = {};
    if (!trigger) e['trigger_kind'] = 'Trigger is required.';
    if (trigger === 'group' && !group) e['group_code'] = 'Body system is required.';
    if (trigger === 'analyte' && !rule?.analyte_id) e['trigger_kind'] = 'Choosing an analyte is not available here yet; use Body system or Any finding.';
    if (!direction) e['direction'] = 'Direction is required.';
    if (!blockId) e['block_id'] = 'Text is required.';
    if (kind === 'followup' && interval === undefined) e['interval_days'] = 'Interval in days is required (1–730).';
    setErrs(e);
    if (Object.keys(e).length) return;
    const body = {
      rule_kind: kind, trigger_kind: trigger!, direction: direction!, block_id: blockId!, priority: priority ?? 100,
      ...(trigger === 'group' ? { group_code: group } : {}), ...(trigger === 'analyte' ? { analyte_id: rule!.analyte_id } : {}),
      ...(trigger !== 'all_in_range' && severity ? { min_severity: severity } : {}),
      ...(kind === 'followup' ? { interval_days: interval, ...(rule?.suggested_test_id ? { suggested_test_id: rule.suggested_test_id } : {}) } : {}),
    };
    const r = await saveRuleAction(ed.versionId, body, rule ? { ruleId: rule.id, version: rule.version } : { key: idem.current });
    if (r.ok) { onClose(); ed.saved(); return; }
    setAlert(ed.failed(r));
    setErrs(byField(r.errors));
  };
  const err = (f: string) => (errs[f] ? { error: errs[f] } : {});

  return (
    <Drawer title={rule ? 'Edit rule' : 'Add rule'} isOpen onClose={onClose}>
      <ErrorAlert text={alert} />
      <Form onSubmit={save} errorSummary={false}>
        <RadioGroup label="Trigger" name="trigger_kind" options={triggers} {...(trigger ? { value: trigger } : {})} onChange={setTrigger} {...err('trigger_kind')} />
        {trigger === 'group' ? <Select label="Body system" name="group_code" options={organGroups} {...(group ? { value: group } : {})} onChange={setGroup} {...err('group_code')} /> : null}
        <Select label="Direction" name="direction" options={DIRECTIONS} {...(direction ? { value: direction } : {})} onChange={setDirection} {...err('direction')} />
        {trigger === 'all_in_range' ? null : (
          <Select label="Minimum severity" name="min_severity" options={SEVERITIES} {...(severity ? { value: severity } : {})} onChange={setSeverity} {...err('min_severity')} />
        )}
        <IntegerField label="Priority" name="priority" min={1} max={999} {...(priority !== undefined ? { value: priority } : {})} onChange={setPriority} {...err('priority')} />
        <Select label="Text" name="block_id" placeholder="Text not chosen" options={blocks.map((b) => ({ value: b.id, label: b.block_key }))} {...(blockId ? { value: blockId } : {})} onChange={setBlockId} {...err('block_id')} />
        {kind === 'followup' ? (
          <>
            <p>{rule?.suggested_test_id ? 'Suggested test: kept from this rule.' : 'Suggested test: chosen from the catalogue (not available on this screen yet).'}</p>
            <IntegerField label="Interval in days" name="interval_days" isRequired min={1} max={730} {...(interval !== undefined ? { value: interval } : {})} onChange={setIntervalDays} {...err('interval_days')} />
          </>
        ) : null}
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}

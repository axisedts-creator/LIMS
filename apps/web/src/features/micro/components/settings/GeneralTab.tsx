'use client';
// 04-UI-UX §5 "General" (AC-14.5). PUT /v1/micro/settings with If-Match "<version>". One section, one Save (LD-140: this is the page's one primary button).
// Read-only (no Save, controls disabled) without micro.config.manage; the API enforces.
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { SettingsForm } from '@lims/ui/components/SettingsForm';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { updateMicroSettingsAction } from '../../server/actions';
import type { MicroSettingsDto, MicroSettingsInput } from '../../server/types';
import { FailNotice, type Fail } from '../common';

type Std = 'none' | 'CLSI' | 'EUCAST';

export function GeneralTab({ settings, canManage, tabs }: { settings: MicroSettingsDto; canManage: boolean; tabs: ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [saved, setSaved] = useState(settings);
  const [std, setStd] = useState<Std>(settings.manual_ast_standard ?? 'none');
  const [zone, setZone] = useState(settings.zone_suggestion_enabled);
  const [mic, setMic] = useState(settings.mic_suggestion_enabled);
  const [hours, setHours] = useState<number | undefined>(settings.default_final_no_growth_hours);
  const [reason, setReason] = useState(settings.early_final_requires_reason);
  const [days, setDays] = useState<number | undefined>(settings.recent_window_days);
  const [fail, setFail] = useState<Fail>();

  const save = async () => {
    if (hours === undefined || days === undefined) return;
    setFail(undefined);
    const input: MicroSettingsInput = {
      ...(std !== 'none' ? { manual_ast_standard: std } : saved.manual_ast_standard ? { unset: ['manual_ast_standard'] as ['manual_ast_standard'] } : {}),
      zone_suggestion_enabled: zone,
      mic_suggestion_enabled: mic,
      default_final_no_growth_hours: hours,
      early_final_requires_reason: reason,
      recent_window_days: days,
    };
    const r = await updateMicroSettingsAction(saved.version, input);
    if (r.ok) {
      setSaved(r.data);
      toast.show({ tone: 'success', title: 'Settings saved' });
      router.refresh();
    } else setFail(r);
  };

  const fields = (
      <>
        <Select<Std>
          label="Standard for manual suggestions"
          name="manual_ast_standard"
          value={std}
          isDisabled={!canManage}
          onChange={setStd}
          options={[{ value: 'none', label: 'None' }, { value: 'CLSI', label: 'CLSI' }, { value: 'EUCAST', label: 'EUCAST' }]}
        />
        <Switch label="Suggest for zone diameters" isSelected={zone} isDisabled={!canManage} onChange={setZone} />
        <Switch label="Suggest for MIC" isSelected={mic} isDisabled={!canManage} onChange={setMic} />
        <p className="lims-description">Not recommended until your microbiologist validates MIC tables.</p>
        <IntegerField label="Default no-growth final after (hours)" name="default_final_no_growth_hours" min={1} max={720} isRequired isDisabled={!canManage} {...(hours !== undefined ? { value: hours } : {})} onChange={setHours} />
        <Switch label="Require a reason for early no-growth finals" isSelected={reason} isDisabled={!canManage} onChange={setReason} />
        <IntegerField label="Recently submitted window (days)" name="recent_window_days" min={1} max={31} isRequired isDisabled={!canManage} {...(days !== undefined ? { value: days } : {})} onChange={setDays} />
      </>
  );
  // T0D-UISETTINGS-1 (LD-353 template 4): kit SettingsForm with the tabs slot, one Save in the sticky bar and the dirty note; read only = the same fields, no form.
  if (!canManage) return <div className="lims-settings"><div className="lims-settings-tabs">{tabs}</div><div className="lims-settings-fields">{fields}</div></div>;
  const dirty = std !== (saved.manual_ast_standard ?? 'none') || zone !== saved.zone_suggestion_enabled || mic !== saved.mic_suggestion_enabled || hours !== saved.default_final_no_growth_hours
    || reason !== saved.early_final_requires_reason || days !== saved.recent_window_days;
  return (
    <>
      <FailNotice fail={fail} />
      <SettingsForm tabs={tabs} onSave={save} isDirty={dirty}>{fields}</SettingsForm>
    </>
  );
}

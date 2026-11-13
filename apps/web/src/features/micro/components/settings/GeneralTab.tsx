'use client';
// 04-UI-UX §5 "General" (AC-14.5). PUT /v1/micro/settings with If-Match "<version>". One section, one Save (LD-140: this is the page's one primary button).
// Read-only (no Save, controls disabled) without micro.config.manage; the API enforces.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { updateMicroSettingsAction } from '../../server/actions';
import type { MicroSettingsDto, MicroSettingsInput } from '../../server/types';
import { FailNotice, type Fail } from '../common';

type Std = 'none' | 'CLSI' | 'EUCAST';

export function GeneralTab({ settings, canManage }: { settings: MicroSettingsDto; canManage: boolean }) {
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

  return (
    <section aria-labelledby="micro-general">
      <h2 id="micro-general">General</h2>
      <FailNotice fail={fail} />
      <Form onSubmit={save}>
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
        {canManage ? <Button type="submit" variant="primary">Save</Button> : null}
      </Form>
    </section>
  );
}

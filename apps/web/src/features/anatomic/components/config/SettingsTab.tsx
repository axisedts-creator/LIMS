'use client';
// 04-UI-UX §4.7 Settings tab (K1/K2): Auto-accession on receipt (Switch), Require complete gross before processing (Switch), Default routine stain (Select of ACTIVE ROUTINE stains),
// Max images per case (IntegerField 1-200), Max images per report (IntegerField 0-24). One [Save] for the section: PUT with If-Match = the settings version and no Idempotency-Key.
// The client ranges are hints (the kit Form blocks an out-of-range value; the API re-checks). AC-14.2: the API refuses a default stain that is not active and routine.
// LD-140 (2026-11-13, binding): kit components only; [Save] is the page's one primary button.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { saveSettingsAction } from '../../server/actions.config';
import type { Settings, StainRecord } from '../../server/config.types';
import { FailNotice } from '../common';
import { cfgText, MfaDialog, type Fail } from './config-shared';

export function SettingsTab({ settings, stains }: { settings: Settings; stains: readonly StainRecord[] }) {
  const router = useRouter();
  const toast = useToast();
  const version = useRef(settings.version); // the newest version, for If-Match of the next save
  const [auto, setAuto] = useState(settings.auto_accession_on_receipt);
  const [gross, setGross] = useState(settings.require_gross_complete_for_processing);
  const [stain, setStain] = useState(settings.default_routine_stain_code);
  const [perCase, setPerCase] = useState<number | undefined>(settings.max_images_per_case);
  const [perReport, setPerReport] = useState<number | undefined>(settings.max_report_images);
  const [fail, setFail] = useState<Fail>();
  const [mfa, setMfa] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);

  const options = stains.filter((s) => s.kind === 'routine' && s.is_active).map((s) => ({ value: s.code, label: s.display }));

  const save = async () => {
    if (busy.current || perCase === undefined || perReport === undefined) return; // one request per press; the fields show why nothing is sent
    busy.current = true;
    setSaving(true);
    setFail(undefined);
    try {
      const r = await saveSettingsAction(version.current, {
        auto_accession_on_receipt: auto, require_gross_complete_for_processing: gross, default_routine_stain_code: stain, max_images_per_case: perCase, max_report_images: perReport,
      });
      if (!r.ok) return r.code === 'auth.mfa_required' ? setMfa(true) : setFail(r);
      version.current = r.data.version;
      toast.show({ tone: 'success', title: 'Saved' });
      router.refresh();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <FailNotice fail={fail} describe={cfgText} />
      <Form onSubmit={save}>
        <Switch label="Auto-accession on receipt" name="auto_accession_on_receipt" isSelected={auto} onChange={setAuto} />
        <Switch label="Require complete gross before processing" name="require_gross_complete_for_processing" isSelected={gross} onChange={setGross} />
        <Select label="Default routine stain" name="default_routine_stain_code" isRequired options={options} value={stain} onChange={setStain} />
        <IntegerField label="Max images per case" name="max_images_per_case" isRequired min={1} max={200} description="1 to 200." {...(perCase !== undefined ? { value: perCase } : {})} onChange={setPerCase} />
        <IntegerField label="Max images per report" name="max_report_images" isRequired min={0} max={24} description="0 to 24." {...(perReport !== undefined ? { value: perReport } : {})} onChange={setPerReport} />
        <div>
          <Button variant="primary" type="submit" isLoading={saving}>Save</Button>
        </div>
      </Form>
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}

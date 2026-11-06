import { useState } from 'react';
import { PeriodPicker, type PeriodPreset, type PeriodValue } from './PeriodPicker';

export default { title: 'Fields/PeriodPicker', component: PeriodPicker };

const ALL: PeriodPreset[] = ['today', 'yesterday', 'this_bs_month', 'last_bs_month', 'this_fy', 'last_fy', 'this_ad_month', 'last_ad_month', 'custom'];

export const Default = {
  render: () => {
    const [v, setV] = useState<PeriodValue>({ preset: 'this_bs_month' });
    return <PeriodPicker label="Period" name="period" value={v} presets={ALL} onChange={setV} calendar="BS" />;
  },
};
export const CustomTooLong = {
  render: () => <PeriodPicker label="Period" name="period" value={{ preset: 'custom', from: '2026-01-01', to: '2027-06-01' }} presets={ALL} onChange={() => {}} calendar="AD" />,
};

import { useState } from 'react';
import { PeriodPicker, type PeriodValue } from './PeriodPicker';

export default { title: 'Fields/PeriodPicker', component: PeriodPicker };

export const Default = {
  render: () => {
    const [v, setV] = useState<PeriodValue>({ preset: 'this_bs_month' });
    return <PeriodPicker label="Period" name="period" value={v} onChange={setV} calendar="BS" />;
  },
};
export const CustomTooLong = {
  render: () => <PeriodPicker label="Period" name="period" value={{ preset: 'custom', from: '2026-01-01', to: '2027-06-01' }} onChange={() => {}} calendar="AD" />,
};

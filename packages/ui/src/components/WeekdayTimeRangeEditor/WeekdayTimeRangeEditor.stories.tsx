import { useState } from 'react';
import { WeekdayTimeRangeEditor, type WeekdayTimeRangeValue } from './WeekdayTimeRangeEditor';

const WORK: WeekdayTimeRangeValue = { weekdays: [1, 2, 3, 4, 5], start: '07:00', end: '11:00' };

const Controlled = ({ minuteStep }: { minuteStep?: 5 | 15 }) => {
  const [v, setV] = useState(WORK);
  return <WeekdayTimeRangeEditor value={v} onChange={setV} {...(minuteStep ? { minuteStep } : {})} />;
};

export default { title: 'Fields/WeekdayTimeRangeEditor', component: WeekdayTimeRangeEditor };

export const MonToFri = { render: () => <Controlled /> };
export const FiveMinuteSteps = { render: () => <Controlled minuteStep={5} /> };
export const Empty = { render: () => <WeekdayTimeRangeEditor value={{ weekdays: [], start: '07:00', end: '11:00' }} onChange={() => {}} /> };

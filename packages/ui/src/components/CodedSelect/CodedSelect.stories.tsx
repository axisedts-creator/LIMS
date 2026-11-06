import { CodedSelect } from './CodedSelect';

export default {
  title: 'Fields/CodedSelect',
  component: CodedSelect,
  args: {
    label: 'Tube',
    name: 'tube',
    codedSet: 'specimen_container',
    options: [
      { code: 'EDTA', display: 'EDTA tube', isActive: true },
      { code: 'OLD', display: 'Retired tube', isActive: false },
    ],
  },
};

export const Default = {};
export const InactiveSelected = { args: { value: 'OLD' } };

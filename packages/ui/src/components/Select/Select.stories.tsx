import { Select } from './Select';

const options = [
  { value: 'blood', label: 'Blood' },
  { value: 'urine', label: 'Urine' },
  { value: 'csf', label: 'CSF', isDisabled: true },
];

export default { title: 'Fields/Select', component: Select, args: { label: 'Specimen type', name: 'specimen_type', options } };

export const Default = { args: { placeholder: 'Choose…' } };
export const Selected = { args: { value: 'urine' } };
export const WithError = { args: { error: 'Enter Specimen type', isRequired: true } };

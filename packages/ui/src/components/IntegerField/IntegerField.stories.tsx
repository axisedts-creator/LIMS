import { IntegerField } from './IntegerField';

export default { title: 'Fields/IntegerField', component: IntegerField, args: { label: 'Age', name: 'age', min: 0, max: 120 } };

export const Default = {};
export const WithValue = { args: { value: 42, onChange: () => {} } };
export const WithError = { args: { error: 'Age must be between 0 and 120' } };

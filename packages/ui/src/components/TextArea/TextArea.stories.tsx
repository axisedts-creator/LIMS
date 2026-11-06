import { TextArea } from './TextArea';

export default { title: 'Fields/TextArea', component: TextArea, args: { label: 'Notes', name: 'notes', maxLength: 200 } };

export const Default = {};
export const WithError = { args: { error: 'Enter Notes', isRequired: true } };
export const Devanagari = { args: { value: 'नमुना टिप्पणी', onChange: () => {} } };

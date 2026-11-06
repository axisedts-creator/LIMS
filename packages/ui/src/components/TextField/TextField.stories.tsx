import { TextField } from './TextField';

export default { title: 'Fields/TextField', component: TextField, args: { label: 'Family name', name: 'family_name', maxLength: 50 } };

export const Default = {};
export const WithDescriptionAndError = { args: { description: 'As on the citizenship card', error: 'Enter Family name', isRequired: true } };
export const PrefixSuffix = { args: { label: 'Weight', name: 'weight', maxLength: 6, prefix: '~', suffix: 'kg' } };
export const Devanagari = { args: { value: 'सुनिता श्रेष्ठ', onChange: () => {} } };
export const Disabled = { args: { isDisabled: true } };

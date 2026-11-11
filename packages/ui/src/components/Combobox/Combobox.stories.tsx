import { Combobox } from './Combobox';

type Doc = { id: string; name: string };
const DOCS: Doc[] = [{ id: 'd1', name: 'Dr Sharma' }, { id: 'd2', name: 'Dr Shrestha' }];

const base = {
  label: 'Referring doctor',
  name: 'doctor',
  loadOptions: async (q: string) => DOCS.filter((d) => d.name.toLowerCase().includes(q.toLowerCase())),
  getKey: (d: Doc) => d.id,
  renderOption: (d: Doc) => d.name,
  renderValue: (d: Doc) => d.name,
};

export default { title: 'Fields/Combobox', component: Combobox, args: base };

export const Default = {};
export const Selected = { args: { value: DOCS[0] } };
export const WithCreate = { args: { allowCreate: { label: 'Add new doctor', onCreate: () => {} } } };
export const WithError = { args: { error: 'Choose a doctor', isRequired: true } };

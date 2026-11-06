import { Button } from './Button';

export default { title: 'Actions/Button', component: Button, args: { children: 'Save' } };

export const Primary = { args: { variant: 'primary' } };
export const Secondary = { args: { variant: 'secondary' } };
export const Danger = { args: { variant: 'danger', children: 'Reject' } };
export const Loading = { args: { variant: 'primary', isLoading: true } };
export const WithShortcut = { args: { variant: 'primary', shortcut: 'Ctrl+Enter' } };
export const Devanagari = { args: { children: 'सुनिता श्रेष्ठ' } };

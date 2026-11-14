import { Switch } from './Switch';

export default { title: 'Fields/Switch', component: Switch, args: { label: 'Active' } };

export const Off = {};
export const On = { args: { isSelected: true } };

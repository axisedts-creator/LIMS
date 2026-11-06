import { Checkbox } from './Checkbox';

export default { title: 'Fields/Checkbox', component: Checkbox, args: { label: 'Urgent' } };

export const Default = {};
export const WithDescription = { args: { description: 'Fast-track this order', isSelected: true } };
export const Disabled = { args: { isDisabled: true } };

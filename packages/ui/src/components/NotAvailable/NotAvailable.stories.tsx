import { NotAvailable } from './NotAvailable';

export default { title: 'Feedback/NotAvailable', component: NotAvailable, args: { title: 'Lab pending' } };

export const Default = {};
export const WithColumns = { args: { columns: ['Sample', 'Patient', 'Received'] } };
export const CustomHint = { args: { body: 'Switched on in the next release.' } };

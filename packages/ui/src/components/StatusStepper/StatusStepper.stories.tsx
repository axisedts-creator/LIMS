import { StatusStepper } from './StatusStepper';

export default { title: 'Data/StatusStepper', component: StatusStepper };

const steps = ['Uploaded', 'Security scan', 'Validating', 'Ready to commit', 'Committing', 'Committed'].map((label, i) => ({ id: `s${i}`, label }));
export const InProgress = { args: { steps, currentId: 's2' } };
export const Failed = { args: { steps, currentId: 's1', outcome: { kind: 'failed', label: 'Security scan found a problem' } } };

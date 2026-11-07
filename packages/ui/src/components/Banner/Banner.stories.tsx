import { Banner } from './Banner';

export default { title: 'Feedback/Banner', component: Banner, args: { tone: 'info', title: 'Maintenance tonight' } };

export const Info = {};
export const WarningWithAction = { args: { tone: 'warning', title: 'Offline', children: 'Changes will sync later.', action: { label: 'Retry now', onPress: () => {} } } };
export const Danger = { args: { tone: 'danger', title: 'Failed' } };

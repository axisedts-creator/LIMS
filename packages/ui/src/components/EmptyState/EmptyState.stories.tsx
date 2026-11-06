import { EmptyState } from './EmptyState';

export default { title: 'Feedback/EmptyState', component: EmptyState, args: { title: 'No orders' } };

export const Default = { args: { body: 'Create one to begin.', action: { label: 'New order', onPress: () => {} } } };
export const TitleOnly = {};

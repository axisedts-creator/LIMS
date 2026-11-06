import { ErrorState } from './ErrorState';

export default { title: 'Feedback/ErrorState', component: ErrorState, args: { title: 'Could not load' } };

export const WithRetry = { args: { body: 'Check your connection.', requestId: '0190a1b2', onRetry: () => {} } };
export const Plain = {};

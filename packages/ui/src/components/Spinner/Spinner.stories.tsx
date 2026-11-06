import { Spinner } from './Spinner';
import { msg } from '../_shared/messages';

export default { title: 'Layout/Spinner', component: Spinner };

export const Loading = {};
export const Working = { args: { label: msg.working } };

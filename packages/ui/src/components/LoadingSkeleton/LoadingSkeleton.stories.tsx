import { LoadingSkeleton } from './LoadingSkeleton';

export default { title: 'Feedback/LoadingSkeleton', component: LoadingSkeleton, args: { rows: 3 } };

export const Page = { args: { variant: 'page' } };
export const Table = { args: { variant: 'table' } };
export const FormVariant = { args: { variant: 'form' } };
export const Detail = { args: { variant: 'detail' } };

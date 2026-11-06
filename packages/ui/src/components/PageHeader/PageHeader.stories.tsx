import { PageHeader } from './PageHeader';
import { Button } from '../Button/Button';
import { StatusChip } from '../StatusChip/StatusChip';

export default { title: 'Shell/PageHeader', component: PageHeader, args: { title: 'Order detail', helpKey: 'orders.detail' } };

export const Default = {
  args: {
    breadcrumbs: [{ label: 'Home', href: '/' }, { label: 'Orders', href: '/orders' }, { label: 'Detail' }],
    actions: <Button variant="primary">Edit</Button>,
    status: <StatusChip kind="order" status="registered" />,
  },
};
export const Devanagari = { args: { title: 'सुनिता श्रेष्ठ' } };

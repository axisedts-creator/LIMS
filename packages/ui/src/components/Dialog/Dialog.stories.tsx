import { Dialog } from './Dialog';
import { Button } from '../Button/Button';

export default { title: 'Overlays/Dialog', component: Dialog };

export const Open = {
  render: () => (
    <Dialog title="Edit order" isOpen onClose={() => {}} footer={<Button variant="primary">Done</Button>}>
      <p>Dialog body text.</p>
    </Dialog>
  ),
};

export const Blocking = {
  render: () => (
    <Dialog title="Session expiring" isOpen isDismissable={false} onClose={() => {}} footer={<Button>Stay signed in</Button>}>
      <p>You will be signed out soon.</p>
    </Dialog>
  ),
};

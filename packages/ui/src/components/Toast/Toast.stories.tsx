import { useEffect } from 'react';
import { ToastProvider, useToast } from './Toast';
import { Button } from '../Button/Button';

function Demo({ tone, title }: { tone: 'success' | 'danger'; title: string }) {
  const { show } = useToast();
  useEffect(() => show({ tone, title, description: 'Order updated' }), [show, tone, title]);
  return <Button onPress={() => show({ tone, title })}>Show toast</Button>;
}

export default { title: 'Feedback/Toast', component: ToastProvider };

export const Success = {
  render: () => (
    <ToastProvider>
      <Demo tone="success" title="Saved" />
    </ToastProvider>
  ),
};
export const Danger = {
  render: () => (
    <ToastProvider>
      <Demo tone="danger" title="Save failed" />
    </ToastProvider>
  ),
};

import { useState } from 'react';
import { Button } from '../Button/Button';
import { PrintFrame } from './PrintFrame';

export default { title: 'Layout/PrintFrame', component: PrintFrame };

export const Default = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onPress={() => setOpen(true)}>Print receipt</Button>
        <PrintFrame title="Receipt" isOpen={open} onDone={() => setOpen(false)}>
          <p>Invoice INV-001 (synthetic)</p>
        </PrintFrame>
      </>
    );
  },
};

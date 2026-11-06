import { Drawer } from './Drawer';

export default { title: 'Overlays/Drawer', component: Drawer };

export const End = {
  render: () => (
    <Drawer title="Specimen details" isOpen onClose={() => {}}>
      <p>Drawer content.</p>
    </Drawer>
  ),
};

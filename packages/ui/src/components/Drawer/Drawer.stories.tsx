import { Drawer, DrawerSection } from './Drawer';

export default { title: 'Overlays/Drawer', component: Drawer };

export const End = {
  render: () => (
    <Drawer title="Specimen details" isOpen onClose={() => {}}>
      <p>Drawer content.</p>
    </Drawer>
  ),
};

export const Sections = {
  render: () => (
    <Drawer title="Centre" isOpen onClose={() => {}}>
      <DrawerSection title="Contact" onSave={() => {}}>
        <p>Phone and email.</p>
      </DrawerSection>
      <DrawerSection title="Billing" onSave={() => {}} isSaving>
        <p>Currency and tax.</p>
      </DrawerSection>
    </Drawer>
  ),
};

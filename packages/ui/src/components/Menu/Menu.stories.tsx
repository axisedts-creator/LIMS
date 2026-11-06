import { Menu } from './Menu';
import { Button } from '../Button/Button';

export default { title: 'Actions/Menu', component: Menu };

export const Default = {
  render: () => (
    <Menu
      trigger={<Button>Actions</Button>}
      items={[
        { id: 'edit', label: 'Edit' },
        { id: 'archive', label: 'Archive', isDisabled: true },
        { id: 'delete', label: 'Delete', isDanger: true },
      ]}
      onAction={() => {}}
    />
  ),
};

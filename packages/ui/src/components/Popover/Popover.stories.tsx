import { Popover } from './Popover';

export default { title: 'Layout/Popover', component: Popover };

export const Closed = {
  render: () => (
    <Popover trigger={<button type="button">Details</button>} title="Specimen details">
      <p>Collected 07:42, tube EDTA.</p>
    </Popover>
  ),
};

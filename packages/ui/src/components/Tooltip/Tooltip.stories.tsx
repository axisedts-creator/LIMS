import { Tooltip } from './Tooltip';

export default { title: 'Layout/Tooltip', component: Tooltip };

export const Default = {
  render: () => (
    <Tooltip content="Print label">
      <button type="button">Print</button>
    </Tooltip>
  ),
};

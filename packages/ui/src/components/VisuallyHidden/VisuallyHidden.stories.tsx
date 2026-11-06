import { VisuallyHidden } from './VisuallyHidden';

export default { title: 'Layout/VisuallyHidden', component: VisuallyHidden };

export const InButton = {
  render: () => (
    <button type="button">
      <VisuallyHidden>Close dialog</VisuallyHidden>
      <span aria-hidden="true">×</span>
    </button>
  ),
};

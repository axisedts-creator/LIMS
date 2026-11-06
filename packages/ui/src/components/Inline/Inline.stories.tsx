import { Inline } from './Inline';

export default { title: 'Layout/Inline', component: Inline };

export const Default = {
  render: () => (
    <Inline>
      <span>One</span>
      <span>Two</span>
    </Inline>
  ),
};

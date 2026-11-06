import { RadioGroup } from './RadioGroup';

export default {
  title: 'Fields/RadioGroup',
  component: RadioGroup,
  args: {
    label: 'Sex',
    name: 'sex',
    options: [
      { value: 'f', label: 'Female' },
      { value: 'm', label: 'Male' },
      { value: 'o', label: 'Other' },
    ],
  },
};

export const Vertical = { args: { value: 'f' } };
export const Horizontal = { args: { orientation: 'horizontal' } };

import { Form } from './Form';
import { TextField } from '../TextField/TextField';
import { DecimalField } from '../DecimalField/DecimalField';
import { Button } from '../Button/Button';

export default { title: 'Fields/Form', component: Form };

export const Default = {
  render: () => (
    <Form onSubmit={() => {}}>
      <TextField label="Patient name" name="family_name" maxLength={50} isRequired />
      <DecimalField label="Weight" name="weight" decimals={2} suffix="kg" />
      <Button type="submit" variant="primary">
        Save
      </Button>
    </Form>
  ),
};

export const ServerProblem = {
  render: () => (
    <Form
      onSubmit={() => {}}
      problem={{
        errors: [
          { path: '/family_name', code: 'common.field_invalid', message: 'Name already registered' },
          { path: '/elsewhere', code: 'common.field_invalid', message: 'General server complaint' },
        ],
      }}
    >
      <TextField label="Patient name" name="family_name" maxLength={50} />
      <Button type="submit" variant="primary">
        Save
      </Button>
    </Form>
  ),
};

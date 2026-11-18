import { Switch } from '../Switch/Switch';
import { TextField } from '../TextField/TextField';
import { SettingsForm } from './SettingsForm';

export default { title: 'Layout/SettingsForm', component: SettingsForm };

export const Default = {
  render: () => (
    <SettingsForm tabs={<nav aria-label="Settings sections"><a href="#general">General</a></nav>} onSave={() => {}}>
      <TextField label="Lab name" name="lab" maxLength={80} />
      <TextField label="Report footer" name="footer" maxLength={200} />
      <Switch label="Print on approval" />
    </SettingsForm>
  ),
};
export const Saving = {
  render: () => (
    <SettingsForm isSaving saveLabel="Save changes" onSave={() => {}}>
      <TextField label="Lab name" name="lab" maxLength={80} />
    </SettingsForm>
  ),
};

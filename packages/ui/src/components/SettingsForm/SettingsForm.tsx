'use client';
// T0D-UIKIT-1, LD-353 template 4 (SETTINGS): tabs slot, one form (at most 32rem, two columns from 64rem, kit.css), switches start aligned,
// sticky Save bar. Submit (button or Enter) calls onSave once and never reloads the page; isSaving blocks a second save.
import type { FormEvent, ReactNode } from 'react';
import { Button } from '../Button/Button';

export interface SettingsFormProps {
  tabs?: ReactNode;
  children: ReactNode;
  onSave: () => void;
  /** Default "Save". */
  saveLabel?: string;
  isSaving?: boolean;
  'data-testid'?: string;
}

export function SettingsForm({ tabs, children, onSave, saveLabel = 'Save', isSaving, ...rest }: SettingsFormProps) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isSaving) onSave();
  };
  return (
    <div className="lims-settings" {...rest}>
      {tabs ? <div className="lims-settings-tabs">{tabs}</div> : null}
      <form className="lims-settings-form" onSubmit={submit} noValidate>
        <div className="lims-settings-fields">{children}</div>
        <div className="lims-settings-bar">
          <Button type="submit" variant="primary" isDisabled={!!isSaving}>
            {saveLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}

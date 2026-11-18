'use client';
// T0D-UIKIT-1, LD-353 template 4 (SETTINGS): tabs slot, one form (at most 32rem, two columns from 64rem, kit.css), switches start aligned,
// sticky Save bar. Submit (button, Enter or Ctrl+Enter) calls onSave once and never reloads the page; isSaving blocks a second save.
// T0D-UISETTINGS-1: the form is the kit Form (field validation, error summary, Ctrl+Enter, labels above); `isDirty` shows "Unsaved changes" in the bar.
import type { ReactNode } from 'react';
import { Button } from '../Button/Button';
import { Form, type ProblemLike } from '../Form/Form';

export interface SettingsFormProps {
  tabs?: ReactNode;
  children: ReactNode;
  onSave: () => void | Promise<void>;
  /** Default "Save". */
  saveLabel?: string;
  isSaving?: boolean;
  /** The form has edits that are not saved yet: the bar says so. */
  isDirty?: boolean;
  /** Server problem+json: field errors mapped by name (kit Form). */
  problem?: ProblemLike;
  'data-testid'?: string;
}

export function SettingsForm({ tabs, children, onSave, saveLabel = 'Save', isSaving, isDirty, problem, ...rest }: SettingsFormProps) {
  return (
    <div className="lims-settings" {...rest}>
      {tabs ? <div className="lims-settings-tabs">{tabs}</div> : null}
      <Form className="lims-settings-form" onSubmit={() => (isSaving ? undefined : onSave())} {...(problem ? { problem } : {})}>
        <div className="lims-settings-fields">{children}</div>
        <div className="lims-settings-bar">
          <Button type="submit" variant="primary" isDisabled={!!isSaving}>
            {saveLabel}
          </Button>
          {isDirty ? <span className="lims-settings-dirty">Unsaved changes</span> : null}
        </div>
      </Form>
    </div>
  );
}

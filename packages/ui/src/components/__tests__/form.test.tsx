// @vitest-environment jsdom
// T0D-12 / 04-UI-UX §2.2 Form + ErrorSummary behaviour; REQ-SEC-088 (server messages are text, never HTML)
// ASSUMED (spec silent): the summary container carries data-testid="error-summary"; the first focusable/summary element receives focus.
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Form } from '../Form/Form';
import { TextField } from '../TextField/TextField';
import { DecimalField } from '../DecimalField/DecimalField';
import { Button } from '../Button/Button';
import { user } from './helpers';

function Harness({ onSubmit = vi.fn(), ...formProps }: any) {
  const [name, setName] = useState('');
  return (
    <Form onSubmit={onSubmit} {...formProps}>
      <TextField label="Patient name" name="family_name" maxLength={50} isRequired value={name} onChange={setName} />
      <Button type="submit" variant="primary">
        Save
      </Button>
    </Form>
  );
}
const summary = () => screen.queryByTestId('error-summary');

describe('Form + ErrorSummary', () => {
  it('invalid submit: onSubmit not called, summary shown with a link per error, focus moves into it', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user().click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    const s = summary()!;
    expect(s).toBeTruthy();
    expect(within(s).getByRole('link', { name: 'Enter Patient name' })).toBeTruthy();
    expect(s.contains(document.activeElement)).toBe(true);
  });

  it('summary link moves focus to the field; field error is linked by aria-describedby', async () => {
    const u = user();
    render(<Harness />);
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await u.click(within(summary()!).getByRole('link', { name: 'Enter Patient name' }));
    const input = screen.getByLabelText(/Patient name/);
    expect(document.activeElement).toBe(input);
    const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain('Enter Patient name');
  });

  it('valid submit calls onSubmit once with FormData keyed by field name; no summary', async () => {
    const onSubmit = vi.fn();
    const u = user();
    render(<Harness onSubmit={onSubmit} />);
    await u.type(screen.getByLabelText(/Patient name/), 'Asha');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0][0] as FormData).get('family_name')).toBe('Asha');
    expect(summary()).toBeNull();
  });

  it('Ctrl+Enter submits by default; not when submitShortcut={false}', async () => {
    const a = vi.fn();
    const u = user();
    const { unmount } = render(<Harness onSubmit={a} />);
    await u.type(screen.getByLabelText(/Patient name/), 'Asha');
    await u.keyboard('{Control>}{Enter}{/Control}');
    expect(a).toHaveBeenCalledTimes(1);
    unmount();

    const b = vi.fn();
    render(<Harness onSubmit={b} submitShortcut={false} />);
    await u.type(screen.getByLabelText(/Patient name/), 'Asha');
    await u.keyboard('{Control>}{Enter}{/Control}');
    expect(b).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter on an invalid form shows the summary instead of submitting', async () => {
    const onSubmit = vi.fn();
    const u = user();
    render(<Harness onSubmit={onSubmit} />);
    screen.getByLabelText(/Patient name/).focus();
    await u.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(summary()).toBeTruthy();
  });

  it('errorSummary={false}: no summary, field error still shown', async () => {
    render(<Harness errorSummary={false} />);
    await user().click(screen.getByRole('button', { name: 'Save' }));
    expect(summary()).toBeNull();
    expect(screen.getByText('Enter Patient name')).toBeTruthy();
  });

  it('server problem: errors[].path (JSON Pointer) maps to field name; unmapped listed in summary only', () => {
    const problem = {
      errors: [
        { path: '/family_name', code: 'common.field_invalid', message: 'Name already registered' },
        { path: '/no_such_field', code: 'common.field_invalid', message: 'General server complaint' },
      ],
    };
    render(<Harness problem={problem} />);
    const s = summary()!;
    expect(within(s).getByRole('link', { name: 'Name already registered' })).toBeTruthy();
    expect(within(s).getByText('General server complaint')).toBeTruthy();
    expect(within(s).queryByRole('link', { name: 'General server complaint' })).toBeNull();
    const ids = (screen.getByLabelText(/Patient name/).getAttribute('aria-describedby') ?? '').split(/\s+/);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain('Name already registered');
  });

  it('server messages are rendered as text, never as HTML (REQ-SEC-088)', () => {
    const problem = { errors: [{ path: '/family_name', code: 'x', message: '<img src=x onerror=alert(1)>' }] };
    const { container } = render(<Harness problem={problem} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('client validation messages: decimals and range (04 §2.2 message keys)', async () => {
    const onSubmit = vi.fn();
    render(
      <Form onSubmit={onSubmit}>
        <DecimalField label="Weight" name="weight" decimals={2} value="1.234" />
        <DecimalField label="Dose" name="dose" decimals={0} min="0" max="10" value="11" />
        <Button type="submit">Save</Button>
      </Form>,
    );
    await user().click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    const s = within(summary()!);
    expect(s.getByText('Weight can have at most 2 decimal places')).toBeTruthy();
    expect(s.getByText('Dose must be between 0 and 10')).toBeTruthy();
  });
});

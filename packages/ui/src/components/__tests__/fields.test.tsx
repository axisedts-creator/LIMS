// @vitest-environment jsdom
// T0D-12 / 04-UI-UX §2.2: TextField, TextArea, IntegerField, DecimalField, MoneyField, Select, CodedSelect, Checkbox, RadioGroup, Switch
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TextField } from '../TextField/TextField';
import { TextArea } from '../TextArea/TextArea';
import { IntegerField } from '../IntegerField/IntegerField';
import { DecimalField } from '../DecimalField/DecimalField';
import { MoneyField } from '../MoneyField/MoneyField';
import { Select } from '../Select/Select';
import { CodedSelect } from '../CodedSelect/CodedSelect';
import { Checkbox } from '../Checkbox/Checkbox';
import { RadioGroup } from '../RadioGroup/RadioGroup';
import { Switch } from '../Switch/Switch';
import { DEVANAGARI, user } from './helpers';

/** Controlled harness that records every onChange value. */
function Ctl({ C, init, spy, ...rest }: any) {
  const [v, setV] = useState(init);
  return (
    <C
      {...rest}
      value={v}
      onChange={(x: any) => {
        spy(x);
        setV(x);
      }}
    />
  );
}
const last = (spy: any) => spy.mock.calls[spy.mock.calls.length - 1]?.[0];

describe('TextField', () => {
  it('label is bound to the input; name + maxLength reach the DOM', () => {
    render(<TextField label="Family name" name="family_name" maxLength={50} />);
    const i = screen.getByLabelText('Family name') as HTMLInputElement;
    expect(i.name).toBe('family_name');
    expect(i.maxLength).toBe(50);
  });

  it('error and description are linked by aria-describedby; input is aria-invalid', () => {
    render(<TextField label="Phone" name="phone" maxLength={15} description="Digits only" error="Enter Phone" />);
    const i = screen.getByLabelText('Phone');
    const ids = (i.getAttribute('aria-describedby') ?? '').split(/\s+/);
    const text = ids.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(text).toContain('Enter Phone');
    expect(text).toContain('Digits only');
    expect(i.getAttribute('aria-invalid')).toBe('true');
  });

  it('isRequired / isDisabled / isReadOnly reach the input', () => {
    const { rerender } = render(<TextField label="A" name="a" maxLength={5} isRequired />);
    const i = screen.getByLabelText(/^A/) as HTMLInputElement;
    expect(i.required || i.getAttribute('aria-required') === 'true').toBe(true);
    rerender(<TextField label="A" name="a" maxLength={5} isDisabled />);
    expect((screen.getByLabelText(/^A/) as HTMLInputElement).disabled).toBe(true);
    rerender(<TextField label="A" name="a" maxLength={5} isReadOnly />);
    expect((screen.getByLabelText(/^A/) as HTMLInputElement).readOnly).toBe(true);
  });

  it('normalises to NFC by default (CV §13): e + U+0301 -> U+00E9', () => {
    const onChange = vi.fn();
    render(<TextField label="Name" name="n" maxLength={20} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'é' } });
    expect(last(onChange)).toBe('é');
  });

  it('keeps Devanagari text intact', () => {
    const onChange = vi.fn();
    render(<TextField label="Name" name="n" maxLength={50} value={DEVANAGARI} onChange={onChange} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(DEVANAGARI);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: DEVANAGARI + '१' } });
    expect(last(onChange)).toBe(DEVANAGARI + '१');
  });

  it('shows prefix and suffix', () => {
    render(<TextField label="Weight" name="w" maxLength={5} prefix="~" suffix="kg" />);
    expect(screen.getByText('kg')).toBeTruthy();
    expect(screen.getByText('~')).toBeTruthy();
  });

  it('forwards data-testid', () => {
    render(<TextField label="X" name="x" maxLength={5} data-testid="tf" />);
    expect(screen.getByTestId('tf')).toBeTruthy();
  });
});

describe('TextArea', () => {
  it('default rows is 3; label bound; maxLength set', () => {
    render(<TextArea label="Notes" name="notes" maxLength={200} />);
    const t = screen.getByLabelText('Notes') as HTMLTextAreaElement;
    expect(t.rows).toBe(3);
    expect(t.maxLength).toBe(200);
  });

  it('shows a character count by default; showCount={false} hides it', () => {
    const { container, rerender } = render(<TextArea label="Notes" name="notes" maxLength={200} value="abc" />);
    expect(container.textContent).toMatch(/3\s*\/\s*200/);
    rerender(<TextArea label="Notes" name="notes" maxLength={200} value="abc" showCount={false} />);
    expect(container.textContent).not.toMatch(/3\s*\/\s*200/);
  });
});

describe('IntegerField', () => {
  it('ArrowUp/ArrowDown step the value and respect min/max', async () => {
    const spy = vi.fn();
    const u = user();
    render(<Ctl C={IntegerField} init={9} spy={spy} label="Age" name="age" min={0} max={10} />);
    const i = screen.getByRole('spinbutton');
    i.focus();
    await u.keyboard('{ArrowUp}');
    expect(last(spy)).toBe(10);
    await u.keyboard('{ArrowUp}');
    expect(last(spy)).toBe(10);
    await u.keyboard('{ArrowDown}');
    expect(last(spy)).toBe(9);
  });

  it('honours step', async () => {
    const spy = vi.fn();
    const u = user();
    render(<Ctl C={IntegerField} init={10} spy={spy} label="Qty" name="qty" min={0} max={100} step={5} />);
    screen.getByRole('spinbutton').focus();
    await u.keyboard('{ArrowUp}');
    expect(last(spy)).toBe(15);
  });

  it('rejects letters and reports undefined when cleared', async () => {
    const spy = vi.fn();
    const u = user();
    render(<Ctl C={IntegerField} init={5} spy={spy} label="Age" name="age" min={0} max={120} />);
    const i = screen.getByRole('spinbutton') as HTMLInputElement;
    await u.clear(i);
    expect(last(spy)).toBeUndefined();
    await u.type(i, 'abc');
    expect(i.value).toBe('');
  });
});

describe('DecimalField (value is a DecimalString, never a float)', () => {
  it('emits strings and keeps trailing zeros', async () => {
    const spy = vi.fn();
    render(<Ctl C={DecimalField} init={undefined} spy={spy} label="Hb" name="hb" decimals={2} />);
    await user().type(screen.getByLabelText('Hb'), '12.50');
    expect(typeof last(spy)).toBe('string');
    expect(last(spy)).toBe('12.50');
  });

  it('does not lose precision on long values', async () => {
    const spy = vi.fn();
    render(<Ctl C={DecimalField} init={undefined} spy={spy} label="V" name="v" decimals={4} />);
    await user().type(screen.getByLabelText('V'), '123456789012345678.1234');
    expect(last(spy)).toBe('123456789012345678.1234');
  });

  it('negative sign is refused unless allowNegative', async () => {
    const spy = vi.fn();
    const u = user();
    render(<Ctl C={DecimalField} init={undefined} spy={spy} label="D" name="d" decimals={1} />);
    await u.type(screen.getByLabelText('D'), '-5');
    expect(spy.mock.calls.some(([v]) => typeof v === 'string' && v.startsWith('-'))).toBe(false);
  });

  it('allowNegative accepts a leading minus', async () => {
    const spy = vi.fn();
    render(<Ctl C={DecimalField} init={undefined} spy={spy} label="D" name="d" decimals={1} allowNegative />);
    await user().type(screen.getByLabelText('D'), '-5');
    expect(last(spy)).toBe('-5');
  });

  it('shows the unit suffix', () => {
    render(<DecimalField label="Hb" name="hb" decimals={1} suffix="g/dL" />);
    expect(screen.getByText('g/dL')).toBeTruthy();
  });
});

describe('MoneyField (value is integer paisa + NPR, no float drift)', () => {
  it.each([
    ['12.34', 1234],
    ['0.07', 7],
    ['19.99', 1999],
    ['1', 100],
    ['1.1', 110],
    ['0.29', 29],
  ])('typing %s -> amount_paisa %i', async (typed, paisa) => {
    const spy = vi.fn();
    render(<Ctl C={MoneyField} init={undefined} spy={spy} label="Amount" name="amount" />);
    await user().type(screen.getByLabelText('Amount'), typed);
    const v = last(spy);
    expect(v).toEqual({ amount_paisa: paisa, currency: 'NPR' });
    expect(Number.isInteger(v.amount_paisa)).toBe(true);
  });

  it('shows an existing value in rupees', () => {
    render(<MoneyField label="Amount" name="amount" value={{ amount_paisa: 123456, currency: 'NPR' }} />);
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toMatch(/1,?234\.56/);
  });

  it('negative refused by default', async () => {
    const spy = vi.fn();
    render(<Ctl C={MoneyField} init={undefined} spy={spy} label="Amount" name="amount" />);
    await user().type(screen.getByLabelText('Amount'), '-5');
    expect(spy.mock.calls.every(([v]) => v === undefined || v.amount_paisa >= 0)).toBe(true);
  });

  it('cleared field reports undefined', async () => {
    const spy = vi.fn();
    const u = user();
    render(<Ctl C={MoneyField} init={{ amount_paisa: 500, currency: 'NPR' }} spy={spy} label="Amount" name="amount" />);
    await u.clear(screen.getByLabelText('Amount'));
    expect(last(spy)).toBeUndefined();
  });
});

describe('Select', () => {
  const options = [
    { value: 'blood', label: 'Blood' },
    { value: 'urine', label: 'Urine' },
    { value: 'csf', label: 'CSF', isDisabled: true },
  ] as const;

  it('opens a listbox of options; click picks one', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<Select label="Specimen type" name="st" options={options} onChange={onChange} />);
    await u.click(screen.getByRole('button', { name: /Specimen type/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Blood', 'Urine', 'CSF']);
    await u.click(screen.getByRole('option', { name: 'Urine' }));
    expect(onChange).toHaveBeenCalledWith('urine');
  });

  it('keyboard: Enter opens, arrows move, Enter selects', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<Select label="Specimen type" name="st" options={options} onChange={onChange} />);
    screen.getByRole('button', { name: /Specimen type/ }).focus();
    await u.keyboard('{Enter}');
    await u.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(['blood', 'urine']).toContain(onChange.mock.calls[0][0]);
  });

  it('disabled option is not selectable; selected label and placeholder show', async () => {
    const onChange = vi.fn();
    const u = user();
    const { rerender } = render(<Select label="T" name="t" options={options} placeholder="Choose…" onChange={onChange} />);
    expect(screen.getByRole('button', { name: /T/ }).textContent).toContain('Choose…');
    await u.click(screen.getByRole('button', { name: /T/ }));
    await u.click(screen.getByRole('option', { name: 'CSF' }));
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Select label="T" name="t" options={options} value="blood" />);
    expect(screen.getByRole('button', { name: /T/ }).textContent).toContain('Blood');
  });
});

describe('CodedSelect', () => {
  const options = [
    { code: 'EDTA', display: 'EDTA tube', isActive: true },
    { code: 'OLD', display: 'Retired tube', isActive: false },
    { code: 'GEL', display: 'Gel tube', isActive: false },
  ];

  it('hides inactive codes unless currently selected; emits the code', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<CodedSelect label="Tube" name="tube" codedSet="specimen_container" options={options} value="OLD" onChange={onChange} />);
    await u.click(screen.getByRole('button', { name: /Tube/ }));
    const shown = screen.getAllByRole('option').map((o) => o.textContent);
    expect(shown).toContain('EDTA tube');
    expect(shown).toContain('Retired tube');
    expect(shown).not.toContain('Gel tube');
    await u.click(screen.getByRole('option', { name: 'EDTA tube' }));
    expect(onChange).toHaveBeenCalledWith('EDTA');
  });
});

describe('Checkbox / RadioGroup / Switch', () => {
  it('Checkbox toggles with click and Space; description is linked', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<Checkbox label="Urgent" description="Fast-track" onChange={onChange} />);
    const c = screen.getByRole('checkbox', { name: /Urgent/ });
    await u.click(c);
    expect(last(onChange)).toBe(true);
    c.focus();
    await u.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
    const ids = (c.getAttribute('aria-describedby') ?? '').split(/\s+/);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain('Fast-track');
  });

  it('Checkbox disabled does not fire', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Urgent" isDisabled onChange={onChange} />);
    await user().click(screen.getByRole('checkbox', { name: /Urgent/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('RadioGroup: named group, click selects, arrows move selection', async () => {
    const onChange = vi.fn();
    const u = user();
    render(
      <RadioGroup
        label="Sex"
        name="sex"
        value="f"
        onChange={onChange}
        options={[
          { value: 'f', label: 'Female' },
          { value: 'm', label: 'Male' },
          { value: 'o', label: 'Other' },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: /Sex/ })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    await u.click(screen.getByRole('radio', { name: 'Other' }));
    expect(onChange).toHaveBeenCalledWith('o');
    screen.getByRole('radio', { name: 'Female' }).focus();
    await u.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('m');
  });

  it('Switch has role switch and toggles by click and Space', async () => {
    const onChange = vi.fn();
    const u = user();
    render(<Switch label="Active" onChange={onChange} />);
    const s = screen.getByRole('switch', { name: 'Active' });
    await u.click(s);
    expect(last(onChange)).toBe(true);
    s.focus();
    await u.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

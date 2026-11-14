// Text entry + optional calendar popover shared by DatePicker / DateTimePicker. Commits on blur or Enter (04-UI-UX §2.3).
import { useEffect, useId, useRef, useState } from 'react';
import { useFormField } from '../Form/FormContext';
import { CalendarGrid } from './CalendarGrid';
import { msg } from './messages';
import type { FieldBase } from './TextInputBase';
import type { CalendarMode, IsoDate } from './dates';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DateFieldBaseProps<T extends string> extends FieldBase {
  value?: T | undefined;
  onChange?: ((v: T | undefined) => void) | undefined;
  format: (v: T) => string;
  parse: (text: string) => ParseResult<T>;
  hint?: ((v: T) => string | undefined) | undefined;
  placeholder: string;
  readOnlyText?: boolean;
  calendar: {
    mode: CalendarMode;
    min?: IsoDate | undefined;
    max?: IsoDate | undefined;
    timezone?: string | undefined;
    toDate: (v: T) => IsoDate | undefined;
    fromPick: (iso: IsoDate, current: T | undefined) => T | undefined;
  };
}

export function DateFieldBase<T extends string>(p: DateFieldBaseProps<T>) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const fmt = (v: T | undefined) => (v === undefined ? '' : p.format(v));
  const [text, setText] = useState(() => fmt(p.value));
  const [own, setOwn] = useState<string>();
  const [open, setOpen] = useState(false);
  const known = useRef<T | undefined>(p.value); // last value we emitted or were given

  useEffect(() => {
    if (p.value === known.current) return;
    known.current = p.value;
    setText(fmt(p.value));
    setOwn(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.value]);

  const emit = (v: T | undefined) => {
    if (v === known.current) return;
    known.current = v;
    p.onChange?.(v);
  };
  const commit = (raw: string) => {
    if (raw.trim() === '') {
      setOwn(undefined);
      emit(undefined);
      return;
    }
    const r = p.parse(raw);
    if (!r.ok) {
      setOwn(r.error);
      emit(undefined);
      return;
    }
    setOwn(undefined);
    setText(p.format(r.value));
    emit(r.value);
  };

  const formError = useFormField(
    p.name,
    {
      validate: () => own ?? (p.isRequired && known.current === undefined ? msg.required(p.label) : undefined),
      focus: () => input.current?.focus(),
    },
    p.error,
  );
  const error = own ?? formError;
  const current = known.current;
  const hint = current !== undefined ? p.hint?.(current) : undefined;
  const ids = { desc: `${id}-d`, hint: `${id}-h`, err: `${id}-e` };
  const describedBy = [p.description && ids.desc, hint && ids.hint, error && ids.err].filter(Boolean).join(' ');
  const locked = p.isDisabled || p.isReadOnly;

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className="lims-field lims-date-field" {...(p['data-testid'] ? { 'data-testid': p['data-testid'] } : {})}>
      <label className="lims-label" htmlFor={id}>
        {p.label}
        {p.isRequired ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="lims-input-group">
        <input
          ref={input}
          id={id}
          className="lims-input"
          type="text"
          name={p.name}
          value={text}
          placeholder={p.placeholder}
          autoComplete="off"
          required={p.isRequired}
          disabled={p.isDisabled}
          readOnly={p.isReadOnly || p.readOnlyText}
          aria-invalid={error ? true : undefined}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => !locked && !p.readOnlyText && commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !locked && !p.readOnlyText) commit(e.currentTarget.value);
          }}
        />
        <button
          ref={button}
          type="button"
          className="lims-btn lims-btn-ghost lims-icon-btn"
          aria-label={`Open calendar for ${p.label}`}
          aria-expanded={open}
          disabled={locked}
          onClick={() => setOpen((o) => !o)}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="5" width="16" height="15" />
            <line x1="4" y1="10" x2="20" y2="10" />
          </svg>
        </button>
      </div>
      {open ? (
        <div role="dialog" aria-label={`Calendar: ${p.label}`} className="lims-popover lims-calendar-popover">
          <CalendarGrid
            calendar={p.calendar.mode}
            selected={current !== undefined ? p.calendar.toDate(current) : undefined}
            min={p.calendar.min}
            max={p.calendar.max}
            {...(p.calendar.timezone ? { timezone: p.calendar.timezone } : {})}
            onClose={close}
            onPick={(iso) => {
              const v = p.calendar.fromPick(iso, current);
              if (v !== undefined) {
                setOwn(undefined);
                setText(p.format(v));
                emit(v);
              }
              close();
            }}
          />
        </div>
      ) : null}
      {p.description ? (
        <p id={ids.desc} className="lims-description">
          {p.description}
        </p>
      ) : null}
      {hint ? (
        <p id={ids.hint} className="lims-description lims-date-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.err} className="lims-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

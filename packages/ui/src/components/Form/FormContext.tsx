import { createContext, useContext, useEffect, useRef } from 'react';

export interface FieldRegistration {
  validate: () => string | undefined;
  focus: () => void;
}

export interface FormContextValue {
  register: (name: string, reg: FieldRegistration) => () => void;
  errors: Readonly<Record<string, string>>;
}

export const FormContext = createContext<FormContextValue | null>(null);

/**
 * Registers a field with the surrounding Form (if any) and returns the error to show:
 * the field's own `error` prop wins, then the Form's client/server error for `name`.
 */
export function useFormField(name: string, reg: FieldRegistration, ownError?: string): string | undefined {
  const ctx = useContext(FormContext);
  const ref = useRef(reg);
  ref.current = reg;
  const register = ctx?.register;
  useEffect(() => register?.(name, { validate: () => ref.current.validate(), focus: () => ref.current.focus() }), [register, name]);
  return ownError || ctx?.errors[name] || undefined;
}

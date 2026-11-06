import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { FormContext, type FieldRegistration, type FormContextValue } from './FormContext';
import { ErrorSummary, type ErrorSummaryItem } from './ErrorSummary';

/** Subset of an RFC 9457 problem+json body the form understands. */
export interface ProblemLike {
  errors?: readonly { path?: string; code?: string; message: string }[];
}

export interface FormProps {
  onSubmit: (data: FormData) => Promise<void> | void;
  children: ReactNode;
  /** Default true: Ctrl+Enter submits. */
  submitShortcut?: boolean;
  /** Default true. */
  errorSummary?: boolean;
  /** Server problem+json: maps errors[].path (JSON Pointer) to fields. */
  problem?: ProblemLike;
  'data-testid'?: string;
}

/** "/family_name" -> "family_name"; nested pointers keep their slashes ("/a/0" -> "a/0"). */
const pointerToName = (p = '') => p.replace(/^\//, '').replace(/~1/g, '/').replace(/~0/g, '~');

export function Form({ onSubmit, children, submitShortcut = true, errorSummary = true, problem, ...rest }: FormProps) {
  const fields = useRef(new Map<string, FieldRegistration>());
  const [names, setNames] = useState<readonly string[]>([]);
  const [clientErrors, setClientErrors] = useState<Readonly<Record<string, string>>>({});
  const [focusSummary, setFocusSummary] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const register = useCallback((name: string, reg: FieldRegistration) => {
    fields.current.set(name, reg);
    setNames([...fields.current.keys()]);
    return () => {
      if (fields.current.get(name) === reg) fields.current.delete(name);
      setNames([...fields.current.keys()]);
    };
  }, []);

  // Server errors: mapped to a field when its name is on the page; otherwise summary-only.
  const { serverErrors, unmapped } = useMemo(() => {
    const serverErrors: Record<string, string> = {};
    const unmapped: string[] = [];
    for (const e of problem?.errors ?? []) {
      const n = pointerToName(e.path);
      if (n && names.includes(n) && !serverErrors[n]) serverErrors[n] = String(e.message);
      else unmapped.push(String(e.message));
    }
    return { serverErrors, unmapped };
  }, [problem, names]);

  const errors = useMemo(() => ({ ...serverErrors, ...clientErrors }), [serverErrors, clientErrors]);
  const ctx = useMemo<FormContextValue>(() => ({ register, errors }), [register, errors]);

  useEffect(() => {
    if (focusSummary) summaryRef.current?.focus();
  }, [focusSummary]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy.current) return;
    const found: Record<string, string> = {};
    for (const [name, f] of fields.current) {
      const m = f.validate();
      if (m) found[name] = m;
    }
    setClientErrors(found);
    if (Object.keys(found).length > 0) {
      if (errorSummary) setFocusSummary((n) => n + 1);
      else fields.current.get(Object.keys(found)[0]!)?.focus();
      return;
    }
    busy.current = true;
    try {
      await onSubmit(new FormData(e.currentTarget));
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (submitShortcut && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.currentTarget.requestSubmit();
    }
  };

  const items: ErrorSummaryItem[] = [
    ...Object.entries(errors).map(([name, message]) => ({ message, focus: () => fields.current.get(name)?.focus() })),
    ...unmapped.map((message) => ({ message })),
  ];

  return (
    <FormContext.Provider value={ctx}>
      <form noValidate className="lims-form" onSubmit={handleSubmit} onKeyDown={onKeyDown} {...rest}>
        {errorSummary && items.length > 0 ? <ErrorSummary ref={summaryRef} items={items} /> : null}
        {children}
      </form>
    </FormContext.Provider>
  );
}

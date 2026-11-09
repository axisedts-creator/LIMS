'use client';
import { useActionState, useEffect, useRef, useState, startTransition, type FormEvent } from 'react';
import { OtpInput } from '@lims/ui/components/OtpInput';
import { sendCode, verifyCode, type CodeState } from './actions';

const MESSAGES = {
  invalid: 'That code is not right.',
  exhausted: 'This code can no longer be used. Send a new code.',
  generic: 'Something went wrong. Please try again later.',
  short: 'Enter all 6 digits of the code.',
} as const;

export function CodeForm({ token }: { token: string }) {
  const [state, action] = useActionState<CodeState, FormData>(verifyCode.bind(null, token), { seq: 0 });
  const [short, setShort] = useState(false);
  const code = useRef('');
  const busy = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const error = short ? 'short' : state.error;

  useEffect(() => {
    busy.current = false;
    code.current = ''; // OtpInput remounts empty on every answer
    if (state.error) alertRef.current?.focus(); // focus moves to the error message (AC-11.3, WCAG 3.3.1)
  }, [state]);
  useEffect(() => {
    if (short) alertRef.current?.focus();
  }, [short]);

  const submit = (v: string) => {
    if (busy.current) return;
    if (v.length !== 6) return setShort(true);
    busy.current = true;
    setShort(false);
    const fd = new FormData();
    fd.set('code', v);
    startTransition(() => action(fd));
  };

  return (
    <>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit(code.current);
        }}
      >
        {error ? (
          <div ref={alertRef} role="alert" tabIndex={-1} className="portal-alert">
            {MESSAGES[error]}
          </div>
        ) : null}
        <OtpInput
          key={state.seq}
          label="6-digit code"
          length={6}
          onChange={(v) => {
            code.current = v;
          }}
          onComplete={submit}
        />
        <button type="submit" className="portal-btn portal-btn-primary">
          View report
        </button>
      </form>
      <form action={sendCode.bind(null, token)}>
        <button type="submit" className="portal-btn">
          Send a new code
        </button>
      </form>
    </>
  );
}

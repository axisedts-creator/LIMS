'use client';
// Copies an id to the clipboard (AD-10 "Record id (short + copy)").
import { useState } from 'react';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="lims-btn lims-btn-ghost lims-btn-sm" aria-label={`Copy ${label}`}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => setDone(true), () => undefined); }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

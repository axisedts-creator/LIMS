'use client';
// Copies an id to the clipboard (AD-10 "Record id (short + copy)").
// T0D-UIX-4 (LD-442): the kit Button (ghost, small); the accessible name stays "Copy <label>" via a visually hidden suffix.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button variant="ghost" size="sm" onPress={() => { void navigator.clipboard?.writeText(value).then(() => setDone(true), () => undefined); }}>
      {done ? 'Copied' : 'Copy'}<VisuallyHidden> {label}</VisuallyHidden>
    </Button>
  );
}

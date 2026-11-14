'use client';
// Shared pieces of SCR-13…17: NPR text, the tax disclaimer, "effective from" state, and ActionDialog (a modal form that sends one
// server action: one Idempotency-Key per attempt — re-used only for the step-up retry, 02-CONVENTIONS §4.5 — double submit blocked,
// ApiError shown as a Banner with field errors at the field, never the raw code).
import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { useToast } from '@lims/ui/components/Toast';
import { formatNpr, TAX_DISCLAIMER, type ActionResult } from '../server/types';
import { FormSection } from './master-ui';
import { FailBanner, newKey, type Fail } from './shared';

export const PERM_READ = 'catalog.price_list.read';
export const PERM_MANAGE = 'catalog.price_list.manage';
export const canManagePrices = (permissions: readonly string[]) => permissions.includes(PERM_MANAGE);
export const npr = (paisa: number) => `NPR ${formatNpr(paisa)}`;
export const nowIso = () => new Date().toISOString();

/** AC-15.4: the same sentence everywhere tax is configured or shown. */
export const TaxDisclaimer = () => <p role="note" className="lims-description">{TAX_DISCLAIMER}</p>;

/** "Effective from" that defaults to Now: untouched → the instant of submit, touched → what was entered. */
export function useWhen() {
  const [value, setValue] = useState(nowIso);
  const touched = useRef(false);
  return {
    value: value as never,
    onChange: (v: string | undefined) => {
      if (v) {
        touched.current = true;
        setValue(v);
      }
    },
    get: () => (touched.current ? value : nowIso()),
  };
}

const DUP = 'This code is already used, or a default price list already exists.';

export function ActionDialog({ title, submit = 'Save', savedText, onClose, check, run, children, onDone, drawer = false }: {
  title: string;
  /** Render as a sectioned drawer (create/edit forms) instead of a centred dialog (confirmations). */
  drawer?: boolean;
  submit?: string;
  savedText: string;
  onClose: () => void;
  /** Client checks (the screen shows its own field errors); false blocks the request. */
  check?: () => boolean;
  run: (idempotencyKey: string) => Promise<ActionResult<unknown>>;
  children: ReactNode | ((fail: Fail | undefined) => ReactNode);
  onDone?: (data: unknown) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [fail, setFail] = useState<Fail>();
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const key = useRef<string>(undefined);

  const go = async () => {
    if (inflight.current || (check && !check())) return;
    inflight.current = true;
    setBusy(true);
    setFail(undefined);
    try {
      key.current ??= newKey();
      const r = await run(key.current);
      if (r.ok) {
        key.current = undefined;
        onDone?.(r.data);
        onClose();
        toast.show({ tone: 'success', title: savedText });
        router.refresh();
      } else {
        if (r.code !== 'auth.mfa_required') key.current = undefined; // a corrected retry is a new request; only the step-up retry is the same one
        setFail(r);
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const banner = fail?.code === 'catalog.code_duplicate' ? (
    <div role="alert"><Banner tone="danger" title={DUP} /></div>
  ) : fail ? <FailBanner fail={fail} /> : null;
  const body = typeof children === 'function' ? children(fail) : children;

  // LD-140 (10-DESIGN-SYSTEM §4): create forms (`drawer`) open in a kit Drawer with one section and its own Save.
  if (drawer) {
    return (
      <Drawer title={title} isOpen onClose={onClose} width="md">
        <Form onSubmit={go} errorSummary={false}>
          {banner}
          <FormSection title="Details" action={<Button type="submit" size="sm" variant="primary" isLoading={busy}>{submit}</Button>}>
            {body}
          </FormSection>
        </Form>
      </Drawer>
    );
  }
  return (
    <Dialog title={title} isOpen onClose={onClose} size="md">
      <Form onSubmit={go} errorSummary={false}>
        {banner}
        {body}
        <Inline gap={2} justify="end">
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" isLoading={busy}>{submit}</Button>
        </Inline>
      </Form>
    </Dialog>
  );
}

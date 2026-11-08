'use client';
// 04-UI-UX §8.11 Billing settings (B32/B33, billing.settings.manage). Tax rates are maintained in Catalog › Pricing › Tax (link only, 08 R18).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { MoneyField } from '@lims/ui/components/MoneyField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { updateBillingSettingsAction } from '../server/actions';
import type { BillingSettings } from '../server/types';
import { errorText } from './format';

type Draft = Omit<BillingSettings, 'version'>;

export function BillingSettingsForm({ settings }: { settings: BillingSettings }) {
  const router = useRouter();
  const toast = useToast();
  const { version, ...initial } = settings;
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string>();
  const key = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD({ ...d, [k]: v }); setError(undefined); key.current = crypto.randomUUID(); };

  const submit = async () => {
    if (inFlight.current) return;
    if (version === undefined) return setError('Reload the page and try again.');
    inFlight.current = true;
    try {
      const r = await updateBillingSettingsAction(version, d, key.current);
      if (r.ok) { toast.show({ tone: 'success', title: 'Settings saved.' }); router.refresh(); } else setError(errorText(r.code));
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <section aria-label="Billing settings">
      <PageHeader title="Billing settings" helpKey="billing.settings" />
      <Form onSubmit={submit}>
        {error ? <div role="alert"><Banner tone="danger" title="Could not save the settings">{error}</Banner></div> : null}
        <RadioGroup<'tenant' | 'branch'>
          label="Invoice series"
          name="invoice_series_scope"
          value={d.invoice_series_scope}
          onChange={(v) => set('invoice_series_scope', v)}
          options={[{ value: 'tenant', label: 'One series for the lab' }, ...(initial.invoice_series_scope === 'branch' ? [{ value: 'branch' as const, label: 'Branch' }] : [])]}
          description="A series per branch is available only when the invoice number pattern contains {branch}." // [CONV] Branch stays hidden until the pattern is readable here
        />
        <Switch label="Prices include tax" isSelected={d.prices_include_tax} onChange={(v) => set('prices_include_tax', v)} />
        <p>Confirm with your auditor before changing how prices and tax are shown.</p>
        <Switch label="Abbreviated invoices" isSelected={d.abbreviated_invoice_enabled} onChange={(v) => set('abbreviated_invoice_enabled', v)} />
        <p>Abbreviated invoices have conditions set by the tax rules. Confirm with your auditor before enabling them.</p>
        <Switch label="Pay by QR" isSelected={d.pay_by_qr_enabled} onChange={(v) => set('pay_by_qr_enabled', v)} />
        <Switch label="Receipt numbering" isSelected={d.receipt_no_enabled} onChange={(v) => set('receipt_no_enabled', v)} />
        <Switch label="Lock credit parties automatically after the credit days" isSelected={d.credit_days_auto_lock} onChange={(v) => set('credit_days_auto_lock', v)} />
        <MoneyField label="Cash variance alert" name="cash_variance_alert" value={{ amountPaisa: d.cash_variance_alert_paisa, currency: 'NPR' }} onChange={(m) => m && set('cash_variance_alert_paisa', m.amountPaisa)} />
        <IntegerField label="Refund alert (per day)" name="refund_alert_per_day" min={0} max={10000} value={d.refund_alert_per_day} onChange={(v) => v !== undefined && set('refund_alert_per_day', v)} />
        <p>Tax rates are maintained in <a className="lims-link" href="/catalog/pricing/tax">Catalog › Pricing › Tax</a>.</p>
        <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Save settings</Button>
      </Form>
    </section>
  );
}

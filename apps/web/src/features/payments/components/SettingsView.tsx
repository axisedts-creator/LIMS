'use client';
// 04-UI-UX §2.6 Payment gateways (settings). One section per gateway for the deployment's environment (the other environment is never shown).
// The key is write-only (REQ-SEC-058, ST-13): it is never displayed, copied or pre-filled; it is sent once, only when the user typed one, and the field is emptied afterwards.
// Fonepay is read-only until the bank's integration document arrives (blocker B8).
// T0D-UISETTINGS-1 (LD-353 template 4): one kit SettingsForm, one tab per gateway plus "Refunds and labels", ONE Save in the sticky bar. Every section stays mounted
// (hidden when not selected). Save calls the existing operations in order, only for the sections that were edited (saveAccountAction per gateway, saveSettingsAction);
// the first failing section is shown and the rest wait. One success toast when all edited sections are saved.
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SettingsForm } from '@lims/ui/components/SettingsForm';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { failText } from '../errors';
import { gatewayLabel, hasPerm } from '../labels';
import { saveAccountAction, saveSettingsAction, testAccountAction } from '../server/actions';
import type { MerchantAccountDto, PaymentSettingsDto } from '../types';

type Iso = DateTextProps['value'];
type Msg = { tone: 'success' | 'info' | 'danger'; title: string } | null;
/** A section's save: true = saved, false = not saved (its own error is shown). */
type Saver = () => Promise<boolean>;
type Part = { onDirty: () => void; register: (save: Saver) => void };
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL = /^[A-Za-z0-9 .,&()-]{1,50}$/;
const ENV_NAME: Record<string, string> = { uat: 'UAT', production: 'Production' };
const TABS = [{ id: 'esewa', label: 'eSewa' }, { id: 'khalti', label: 'Khalti' }, { id: 'fonepay', label: 'Fonepay' }, { id: 'settings', label: 'Refunds and labels' }] as const;
const ORDER = TABS.map((t) => t.id as string);
const TEST_TEXT = (gateway: string, outcome: string | undefined): NonNullable<Msg> => {
  const g = gatewayLabel(gateway);
  switch (outcome) {
    case 'reachable_key_valid': return { tone: 'success', title: `${g} accepted the key.` };
    case 'reachable_key_unverifiable': return { tone: 'info', title: `${g} is reachable. ${g} does not let us check the secret key without a real payment — make a small test payment in UAT before going live.` };
    case 'auth_failed': return { tone: 'danger', title: 'The provider rejected the key.' };
    case 'unreachable': return { tone: 'danger', title: 'Could not reach the provider. Try again later.' };
    default: return { tone: 'danger', title: 'The connection test could not be run. Try again later.' };
  }
};
const isHttps = (v: string) => {
  try { return v.length <= 300 && new URL(v).protocol === 'https:'; } catch { return false; }
};

export interface SettingsViewProps { environment: string; accounts: readonly MerchantAccountDto[]; settings: PaymentSettingsDto; permissions: readonly string[] }

export function SettingsView({ environment, accounts, settings, permissions }: SettingsViewProps) {
  const router = useRouter();
  const toast = useToast();
  const canManage = hasPerm(permissions, 'payments.merchant_config.manage');
  const mine = accounts.filter((a) => a.environment === environment);
  const of = (g: string) => mine.find((a) => a.gateway === g);
  const [tab, setTab] = useState<string>('esewa');
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const savers = useRef(new Map<string, Saver>());
  const part = (id: string): Part => ({ onDirty: () => setDirty((d) => (d.has(id) ? d : new Set(d).add(id))), register: (s) => { savers.current.set(id, s); } });

  const save = async () => {
    if (!canManage || saving || dirty.size === 0) return;
    setSaving(true);
    let savedAny = false;
    try {
      for (const id of ORDER.filter((x) => dirty.has(x))) {
        if (!(await savers.current.get(id)?.())) { setTab(id); return; } // the failing section is shown with its error; nothing after it is sent
        savedAny = true;
        setDirty((d) => { const n = new Set(d); n.delete(id); return n; });
      }
      toast.show({ tone: 'success', title: 'Settings saved.' });
    } finally {
      setSaving(false);
      if (savedAny) router.refresh(); // fresh versions for the next save
    }
  };

  return (
    <>
      <PageHeader title="Payment gateways" helpKey="payments.settings" />
      <Banner tone="neutral" title={`Environment: ${ENV_NAME[environment] ?? environment}`} />
      <SettingsForm
        tabs={<Tabs aria-label="Payment settings sections" items={TABS} selectedId={tab} onChange={setTab} />}
        onSave={save} isSaving={saving || !canManage} isDirty={dirty.size > 0}
      >
        <div className="lims-settings-section" hidden={tab !== 'esewa'}>
          <GatewaySection gateway="esewa" environment={environment} account={of('esewa')} canManage={canManage} part={part('esewa')} />
        </div>
        <div className="lims-settings-section" hidden={tab !== 'khalti'}>
          <GatewaySection gateway="khalti" environment={environment} account={of('khalti')} canManage={canManage} part={part('khalti')} />
        </div>
        <div className="lims-settings-section" hidden={tab !== 'fonepay'}>
          <StatusChip kind="generic" status="unavailable" tone="neutral" label="Not available yet" />
          <p>Waiting for the Fonepay merchant integration document from your bank (blocker B8).</p>
          <Switch label="Enabled" isSelected={false} isDisabled />
        </div>
        <div className="lims-settings-section" hidden={tab !== 'settings'}>
          <SettingsSection settings={settings} canManage={canManage} part={part('settings')} />
        </div>
      </SettingsForm>
    </>
  );
}

/** A native password input: the kit has no write-only secret field yet (CR-C15-011). Never given a value from a DTO. */
function SecretInput({ label, value, onChange, disabled, error }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean; error?: string | undefined }) {
  const id = useId();
  return (
    <div className="lims-field">
      <label className="lims-label" htmlFor={id}>{label}</label>
      <div className="lims-input-group">
        <input
          id={id} className="lims-input" type="password" name="secret_input" autoComplete="new-password" maxLength={256} value={value} disabled={disabled}
          aria-invalid={error ? true : undefined} {...(error ? { 'aria-describedby': `${id}-e` } : {})} onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {error ? <p id={`${id}-e`} className="lims-error">{error}</p> : null}
    </div>
  );
}

function GatewaySection({ gateway, environment, account, canManage, part }: { gateway: 'esewa' | 'khalti'; environment: string; account: MerchantAccountDto | undefined; canManage: boolean; part: Part }) {
  const secretSet = account?.secret?.is_set === true;
  const [enabled, setEnabled] = useState(account?.is_enabled ?? false);
  const [code, setCode] = useState(account?.esewa_product_code ?? '');
  const [url, setUrl] = useState(account?.khalti_website_url ?? '');
  const [apiRefunds, setApiRefunds] = useState(account?.api_refunds_enabled ?? false);
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<{ code?: string; url?: string; secret?: string }>({});
  const [msg, setMsg] = useState<Msg>(null);
  const [test, setTest] = useState<Msg>(null);
  const testing = useRef(false);
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); part.onDirty(); };

  part.register(async () => {
    const e: { code?: string; url?: string; secret?: string } = {};
    const c = code.trim();
    const u = url.trim();
    if (gateway === 'esewa' && (enabled || c)) {
      if (!c) e.code = 'Enter Product code';
      else if (!CODE.test(c)) e.code = 'Product code can only use letters, numbers, _ and -';
      else if (environment === 'production' && c === 'EPAYTEST') e.code = 'This test product code cannot be used in production';
    }
    if (gateway === 'khalti' && (enabled || u)) {
      if (!u) e.url = 'Enter Website URL';
      else if (!isHttps(u)) e.url = 'Website URL must be a full https:// address';
    }
    if (enabled && !secretSet && !secret) e.secret = 'Enter Secret key';
    setErrors(e);
    setMsg(null);
    if (e.code || e.url || e.secret) return false;
    const res = await saveAccountAction(gateway, environment, account?.version, {
      is_enabled: enabled,
      ...(gateway === 'esewa' && c ? { esewa_product_code: c } : {}),
      ...(gateway === 'khalti' ? { ...(u ? { khalti_website_url: u } : {}), api_refunds_enabled: apiRefunds } : {}),
      ...(secret ? { secret } : {}),
    });
    setSecret(''); // success or not, the typed key never stays on screen
    if (!res.ok) setMsg({ tone: 'danger', title: failText(res) });
    return res.ok;
  });

  const runTest = async () => {
    if (testing.current || !canManage) return;
    testing.current = true;
    setTest(null);
    try {
      const res = await testAccountAction(gateway, environment);
      setTest(res.ok ? TEST_TEXT(gateway, res.outcome) : TEST_TEXT(gateway, undefined));
    } finally {
      testing.current = false;
    }
  };

  return (
    <>
      {/* RS-C15 A3 (LD-140): saved status as tone + icon + word; the Enabled switch below stays the control */}
      <StatusChip kind="generic" status={account?.is_enabled ? 'enabled' : 'disabled'} tone={account?.is_enabled ? 'success' : 'neutral'} label={account?.is_enabled ? 'Enabled' : 'Disabled'} />
      {msg ? <div role="alert"><Banner tone={msg.tone} title={msg.title} /></div> : null}
      <Switch label="Enabled" isSelected={enabled} onChange={edit(setEnabled)} isDisabled={!canManage} />
      {gateway === 'esewa' ? (
        <TextField label="Product code" name="esewa_product_code" maxLength={64} value={code} onChange={edit(setCode)} isReadOnly={!canManage} {...(errors.code ? { error: errors.code } : {})} />
      ) : (
        <>
          <TextField
            label="Website URL" name="khalti_website_url" maxLength={300} description="Khalti requires your website address." value={url} onChange={edit(setUrl)} isReadOnly={!canManage}
            {...(errors.url ? { error: errors.url } : {})}
          />
          <Switch label="Use Khalti refund API" isSelected={apiRefunds} onChange={edit(setApiRefunds)} isDisabled={!canManage} />
          <p className="lims-description">Only after the LIMS provider has confirmed the refund API in the sandbox. Otherwise refunds are done in the Khalti dashboard.</p>
        </>
      )}
      {secretSet ? <p>Set{account?.secret?.set_at ? <> on <DateText value={account.secret.set_at as Iso} /></> : null}{account?.secret?.fingerprint ? ` · fingerprint ${account.secret.fingerprint}` : ''}</p> : null}
      <SecretInput label={secretSet ? 'Replace secret key' : 'Secret key'} value={secret} onChange={edit(setSecret)} disabled={!canManage} error={errors.secret} />
      <div>
        <Button isDisabled={!canManage} onPress={() => void runTest()}>Test connection</Button>
      </div>
      {test ? <div role="status"><Banner tone={test.tone} title={test.title} /></div> : null}
    </>
  );
}

function SettingsSection({ settings, canManage, part }: { settings: PaymentSettingsDto; canManage: boolean; part: Part }) {
  const [threshold, setThreshold] = useState<Money | undefined>({ amountPaisa: settings.refund_two_person_threshold.amount_paisa, currency: 'NPR' });
  const [label, setLabel] = useState(settings.purchase_order_label);
  const [recon, setRecon] = useState(settings.reconciliation_enabled);
  const [errors, setErrors] = useState<{ threshold?: string; label?: string }>({});
  const [msg, setMsg] = useState('');
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); part.onDirty(); };

  part.register(async () => {
    const e: { threshold?: string; label?: string } = {};
    if (!threshold || threshold.amountPaisa < 0) e.threshold = 'Enter Two-person threshold (0 or more)';
    if (!LABEL.test(label)) e.label = 'Order label needs 1–50 letters, numbers, spaces or . , & ( ) -';
    setErrors(e);
    setMsg('');
    if (e.threshold || e.label || !threshold) return false;
    const res = await saveSettingsAction(settings.version, { thresholdPaisa: threshold.amountPaisa, label, reconciliationEnabled: recon });
    if (!res.ok) setMsg(failText(res));
    return res.ok;
  });

  return (
    <>
      {msg ? <div role="alert"><Banner tone="danger" title={msg} /></div> : null}
      <MoneyField
        label="Two-person threshold" name="refund_two_person_threshold" description="Refunds above this amount always need a second approver. 0 = always."
        {...(threshold ? { value: threshold } : {})} onChange={edit(setThreshold)} isReadOnly={!canManage} {...(errors.threshold ? { error: errors.threshold } : {})}
      />
      <TextField
        label="Order label sent to Khalti" name="purchase_order_label" maxLength={50} description="Shown to the patient on the Khalti page. Do not include patient or test names."
        value={label} onChange={edit(setLabel)} isReadOnly={!canManage} {...(errors.label ? { error: errors.label } : {})}
      />
      <Switch label="Nightly reconciliation" isSelected={recon} onChange={edit(setRecon)} isDisabled={!canManage} />
    </>
  );
}

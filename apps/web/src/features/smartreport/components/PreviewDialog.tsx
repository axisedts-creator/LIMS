'use client';
// SR-04 "Preview" (#22, 04-UI-UX SR-04): a synthetic example, or a real order id (only with lab.result.read). Read-only; the result is rendered as text nodes only (REQ 088).
// The order id goes in the request body of a server action, never into a URL, the browser history or a log.
import { useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { previewAction } from '../server/actions';
import { TextList } from './common';
import { FIXTURES, UUID_RE, type Fixture, type Preview } from '../library';

const FIXTURE_LABEL: Record<Fixture, string> = { synthetic_basic: 'Basic', synthetic_all_in_range: 'All in range', synthetic_critical: 'Critical value' };
const NO_ORDER = 'Not enough mapped results in this order to build a summary.';

function failText(r: { status: number; code: string }) {
  if (r.code === 'smartreport.no_eligible_results') return NO_ORDER;
  if (r.status === 403) return 'You do not have permission to preview this order.';
  if (r.status === 404) return 'The order or this version was not found.';
  return 'Could not build the preview. Try again.';
}

export function PreviewDialog({ versionId, canPreviewOrder, isOpen, onClose }: { versionId: string; canPreviewOrder: boolean; isOpen: boolean; onClose: () => void }) {
  const [source, setSource] = useState<'synthetic' | 'order'>('synthetic');
  const [fixture, setFixture] = useState<Fixture>('synthetic_basic');
  const [orderId, setOrderId] = useState('');
  const [orderError, setOrderError] = useState<string>();
  const [alert, setAlert] = useState<string>();
  const [result, setResult] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const run = async () => {
    if (inFlight.current) return;
    setAlert(undefined); setResult(undefined); setOrderError(undefined);
    const id = orderId.trim();
    if (source === 'order' && !UUID_RE.test(id)) { setOrderError('Enter a valid order id.'); return; }
    inFlight.current = true; setBusy(true);
    try {
      const r = await previewAction(versionId, source === 'order' ? { order_id: id } : { fixture_code: fixture });
      if (r.ok) setResult(r.data); else setAlert(failText(r));
    } finally { inFlight.current = false; setBusy(false); }
  };

  const close = () => { setOrderId(''); setResult(undefined); setAlert(undefined); setOrderError(undefined); onClose(); }; // nothing from a real order outlives the dialog
  return (
    <Dialog
      title="Preview summary" isOpen={isOpen} onClose={close} size="lg"
      footer={<Button variant="primary" isLoading={busy} onPress={() => void run()}>Run preview</Button>}
    >
      <RadioGroup<'synthetic' | 'order'>
        label="Source" name="preview_source" value={source} onChange={setSource}
        options={[{ value: 'synthetic', label: 'Synthetic example' }, ...(canPreviewOrder ? [{ value: 'order' as const, label: 'Real order' }] : [])]}
      />
      {source === 'synthetic' ? (
        <Select<Fixture> label="Example" name="fixture_code" value={fixture} onChange={setFixture} options={FIXTURES.map((f) => ({ value: f, label: FIXTURE_LABEL[f] }))} />
      ) : (
        <TextField label="Order id" name="order_id" description="Paste the order id from the lab screen." value={orderId} onChange={setOrderId} maxLength={100} {...(orderError ? { error: orderError } : {})} />
      )}
      {alert ? <div role="alert"><Banner tone="danger" title={alert} /></div> : null}
      {result ? <PreviewResult p={result} /> : null}
    </Dialog>
  );
}

// LD-436 rule 7: titled cards of text lines instead of raw h3 / ul.
function PreviewResult({ p }: { p: Preview }) {
  return (
    <Stack gap={3}>
      {p.score ? <p><strong>Health score: {p.score.value}</strong> ({p.score.band})</p> : null}
      {p.score?.explanation ? <p>{p.score.explanation}</p> : null}
      <TextList title="Body systems" items={p.panels.map((x) => `${x.name} — ${x.status}`)} />
      <TextList title="Findings" items={p.deranged} />
      <TextList title="Advice" items={p.advice} />
      <TextList title="Follow-up" items={p.followUps} />
      {p.disclaimer ? <p>{p.disclaimer}</p> : null}
    </Stack>
  );
}

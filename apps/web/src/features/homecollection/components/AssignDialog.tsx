'use client';
// §2.1 Assign dialog (H12 + H3; also the reassign path, US-03-7). The phlebotomist list is loaded through a server action when the dialog opens.
// A full route / day is shown disabled with "(route full)". One Idempotency-Key per distinct choice: a retry of the same choice re-sends the same key.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Spinner } from '@lims/ui/components/Spinner';
import { useToast } from '@lims/ui/components/Toast';
import { assignFailText, dayOfInstant } from '../labels';
import { assignAction, phlebotomistsAction } from '../server/actions';
import { useSubmissionKey } from '../submission';
import type { PhlebotomistOption, VisitDto } from '../types';

export interface AssignDialogProps {
  visit: VisitDto;
  centreId: string;
  boardDate: string;
  isOpen: boolean;
  onClose: () => void;
}
type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; options: PhlebotomistOption[] };

export function AssignDialog({ visit, centreId, boardDate, isOpen, onClose }: AssignDialogProps) {
  const router = useRouter();
  const toast = useToast();
  const keyFor = useSubmissionKey();
  const wrap = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const saved = useRef(false);
  const windowDay = dayOfInstant(visit.window_start);
  const [routeDate, setRouteDate] = useState<string>(windowDay ?? boardDate);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [membershipId, setMembershipId] = useState<string>();
  const [position, setPosition] = useState<number>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false); // assigned: the dialog is closing, a further click must not send a second request

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setLoad({ state: 'loading' });
    setMembershipId(undefined);
    phlebotomistsAction(centreId, routeDate).then(
      (r) => { if (alive) setLoad(r.ok ? { state: 'ready', options: r.data } : { state: 'error' }); },
      () => { if (alive) setLoad({ state: 'error' }); },
    );
    return () => { alive = false; };
  }, [isOpen, centreId, routeDate]);

  const submit = async () => {
    if (inFlight.current || saved.current || !membershipId) return;
    setError('');
    if (position !== undefined && (!Number.isInteger(position) || position < 1 || position > 60)) { setError('Position must be between 1 and 60.'); return; }
    const body = { membershipId, routeDate, ...(position !== undefined ? { position } : {}) };
    inFlight.current = true;
    setPending(true);
    try {
      const res = await assignAction(visit.id, visit.version, body, keyFor(JSON.stringify(body)));
      if (!res.ok) { setError(assignFailText(res)); return; }
      saved.current = true;
      setDone(true);
      toast.show({ tone: 'success', title: 'Visit assigned.' });
      router.refresh();
      onClose();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const options = load.state === 'ready'
    ? load.options.map((p) => ({ value: p.membership_id, label: `${p.display_name} — ${p.active_visits} visits today${p.route_full ? ' (route full)' : ''}`, isDisabled: p.route_full }))
    : [];
  return (
    <Dialog
      title="Assign visit" isOpen={isOpen} onClose={onClose} size="md"
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button>
          <Button variant="primary" isDisabled={load.state !== 'ready' || pending || done} onPress={() => wrap.current?.querySelector('form')?.requestSubmit()}>Assign</Button>
        </>
      }
    >
      <div ref={wrap}>
        <Form onSubmit={submit}>
          {visit.kind === 'booking' && !visit.order_id ? <Banner tone="info" title="Assigning registers the order and issues the bill in front desk." /> : null}
          {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
          {load.state === 'error' ? <div role="alert"><Banner tone="danger" title="We couldn't load the phlebotomists. Try again." /></div> : null}
          {load.state === 'loading' ? <Spinner label="Loading phlebotomists" /> : null}
          <DatePicker
            label="Route date" name="route_date" isRequired isReadOnly={!!windowDay} value={routeDate as IsoDate}
            onChange={(d) => { if (d) setRouteDate(d); }}
          />
          {load.state === 'ready' ? (
            <>
              <Select label="Phlebotomist" name="phlebotomist_membership_id" isRequired options={options} {...(membershipId ? { value: membershipId } : {})} onChange={setMembershipId} />
              <IntegerField label="Position" name="route_sequence" min={1} max={60} description="Leave empty to add at the end of the route." {...(position !== undefined ? { value: position } : {})} onChange={setPosition} />
            </>
          ) : null}
        </Form>
      </div>
    </Dialog>
  );
}

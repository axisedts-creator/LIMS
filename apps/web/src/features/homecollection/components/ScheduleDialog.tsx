'use client';
// §2.1 Schedule dialog (H5): Dialog size=md + Form. Window, address, landmark, coordinates, note. Every rule below is checked again by the server.
// LD-140 (2026-11-13): kit components and tokens only. One Idempotency-Key per distinct submission (a retry of the same body re-sends the same key).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { addDays, dayNpt, dayOfInstant, failText, instantOf, timeOfInstant } from '../labels';
import { scheduleAction } from '../server/actions';
import { useSubmissionKey } from '../submission';
import type { ScheduleBody, VisitDto } from '../types';

type Instant = DateTimePickerProps['value'];
const HALF_HOUR = 30 * 60_000;
const MAX_WINDOW = 12 * 3_600_000;
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString() as Instant;

export interface ScheduleDialogProps {
  /** VisitSummaryDto, or VisitDetailDto when the caller has it (then address, note and coordinates are prefilled). */
  visit: VisitDto;
  boardDate: string;
  isOpen: boolean;
  onClose: () => void;
}
interface Errs { from?: string; to?: string; lat?: string; lon?: string }

export function ScheduleDialog({ visit, boardDate, isOpen, onClose }: ScheduleDialogProps) {
  const router = useRouter();
  const toast = useToast();
  const keyFor = useSubmissionKey();
  const wrap = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const saved = useRef(false);
  const a = visit.address;
  const day0 = dayOfInstant(visit.window_start) ?? boardDate;
  const from0 = (visit.window_start ?? instantOf(day0, '07:00')) as Instant;

  const [date, setDate] = useState<IsoDate>(day0 as IsoDate);
  const [from, setFrom] = useState<Instant | undefined>(from0);
  const [to, setTo] = useState<Instant | undefined>((visit.window_end ?? plus(from0!, HALF_HOUR)) as Instant);
  const [address, setAddress] = useState(a?.address_text ?? '');
  const [landmark, setLandmark] = useState(a?.landmark ?? '');
  const [lat, setLat] = useState<string | undefined>(a?.latitude);
  const [lon, setLon] = useState<string | undefined>(a?.longitude);
  const [note, setNote] = useState(visit.note_for_phlebotomist ?? '');
  const [errs, setErrs] = useState<Errs>({});
  const [serverError, setServerError] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false); // saved: the dialog is closing, a further click must not send a second request

  const today = dayNpt();
  const pickDate = (d: IsoDate | undefined) => {
    if (!d) return;
    setDate(d);
    if (from) setFrom(instantOf(d, timeOfInstant(from)) as Instant);
    if (to) setTo(instantOf(d, timeOfInstant(to)) as Instant);
  };
  const pickFrom = (v: Instant | undefined) => {
    setFrom(v);
    if (!v) return;
    setDate(dayOfInstant(v) as IsoDate);
    if (to && Date.parse(to) <= Date.parse(v)) setTo(plus(v, HALF_HOUR)); // keep the window valid when From moves past To
  };

  const check = (): Errs => {
    const e: Errs = {};
    if (!from || !to) return e; // the Form already asked for them
    const day = dayOfInstant(from)!;
    if (day < today) e.from = 'Choose today or a later date; a visit cannot be scheduled in the past.';
    else if (day > addDays(today, 30)) e.from = 'Choose a date within 30 days from today.';
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0) e.to = 'To must be after From.';
    else if (span > MAX_WINDOW) e.to = 'The window can be at most 12 hours.';
    const hasLat = !!lat?.trim();
    const hasLon = !!lon?.trim();
    if (hasLat !== hasLon) e[hasLat ? 'lon' : 'lat'] = 'Enter both latitude and longitude, or neither.';
    if (hasLat && Math.abs(Number(lat)) > 90) e.lat = 'Latitude must be between -90 and 90.';
    if (hasLon && Math.abs(Number(lon)) > 180) e.lon = 'Longitude must be between -180 and 180.';
    return e;
  };

  const submit = async () => {
    if (inFlight.current || saved.current || !from || !to) return;
    setServerError('');
    const e = check();
    setErrs(e);
    if (Object.keys(e).length) return;
    const hadCoords = !!(a?.latitude || a?.longitude);
    const unset = [
      ...(a?.landmark && !landmark.trim() ? ['landmark'] : []),
      ...(visit.note_for_phlebotomist && !note.trim() ? ['note_for_phlebotomist'] : []),
      ...(hadCoords && !lat?.trim() && !lon?.trim() ? ['coordinates'] : []),
    ];
    const body: ScheduleBody = {
      window_start: from, window_end: to,
      address: { address_text: address.trim(), ...(landmark.trim() ? { landmark: landmark.trim() } : {}), ...(lat?.trim() && lon?.trim() ? { latitude: lat.trim(), longitude: lon.trim() } : {}) },
      ...(note.trim() ? { note_for_phlebotomist: note.trim() } : {}),
      ...(unset.length ? { unset } : {}),
    };
    inFlight.current = true;
    setPending(true);
    try {
      const res = await scheduleAction(visit.id, visit.version, body, keyFor(JSON.stringify(body)));
      if (!res.ok) { setServerError(failText(res, 'Check the window and address, then try again.')); return; }
      saved.current = true;
      setDone(true);
      toast.show({ tone: 'success', title: 'Visit scheduled.' });
      router.refresh();
      onClose();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title="Schedule visit" isOpen={isOpen} onClose={onClose} size="md"
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button>
          <Button variant="primary" isDisabled={pending || done} onPress={() => wrap.current?.querySelector('form')?.requestSubmit()}>Schedule</Button>
        </>
      }
    >
      <div ref={wrap}>
        <Form onSubmit={submit}>
          {serverError ? <div role="alert"><Banner tone="danger" title={serverError} /></div> : null}
          <DatePicker label="Date" name="date" isRequired min={today as IsoDate} max={addDays(today, 30) as IsoDate} value={date} onChange={pickDate} />
          <DateTimePicker label="From" name="window_start" isRequired minuteStep={15} {...(from ? { value: from } : {})} onChange={pickFrom} {...(errs.from ? { error: errs.from } : {})} />
          <DateTimePicker label="To" name="window_end" isRequired minuteStep={15} {...(to ? { value: to } : {})} onChange={setTo} {...(errs.to ? { error: errs.to } : {})} />
          <TextArea label="Address" name="address_text" isRequired rows={3} maxLength={500} value={address} onChange={setAddress} />
          <TextField label="Landmark" name="landmark" maxLength={200} value={landmark} onChange={setLandmark} />
          <DecimalField label="Latitude" name="latitude" decimals={6} min="-90" max="90" allowNegative {...(lat !== undefined ? { value: lat } : {})} onChange={setLat} {...(errs.lat ? { error: errs.lat } : {})} />
          <DecimalField label="Longitude" name="longitude" decimals={6} min="-180" max="180" allowNegative {...(lon !== undefined ? { value: lon } : {})} onChange={setLon} {...(errs.lon ? { error: errs.lon } : {})} />
          <TextArea
            label="Note for phlebotomist" name="note_for_phlebotomist" rows={2} maxLength={500} value={note} onChange={setNote}
            description="Visible on the phlebotomist's phone. Don't write test names, results or diagnoses."
          />
        </Form>
      </div>
    </Dialog>
  );
}

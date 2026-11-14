'use client';
// C16.T-B6 W3 New booking (04-UI-UX W3; TRD S3 createBookingForPatient, S6 slots; AC-15.1). Ctrl+Enter submits.
// Patient search goes through actions.searchPatients (C4 via the BFF, min 3 characters). Tests come from the S12 bookable list, max 20.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { IconButton } from '@lims/ui/components/IconButton';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import {
  KIND_OPTIONS, bookingProblem, hhmm, type BookingKind, type Centre, type PatientHit, type StaffBookableItem, type StaffBooking, type StaffSlot,
} from './booking-model';

export interface HomeAddressInput { label: 'home' | 'work' | 'other'; address_text: string; landmark?: string; municipality?: string; ward_no?: number; district?: string }
export interface CreateBookingBody { patient_id: string; booking_kind: BookingKind; centre_id?: string; slot_start: string; orderable_ids: string[]; home_address?: HomeAddressInput }
export interface BookingNewActions {
  searchPatients(q: string): Promise<PatientHit[]>;
  listSlots(q: { centre_id: string; booking_kind: BookingKind; date: string }): Promise<StaffSlot[]>;
  create(body: CreateBookingBody): Promise<StaffBooking>;
}
export interface BookingNewProps { centres: readonly Centre[]; workingCentreId: string; today: string; bookableItems: readonly StaffBookableItem[]; actions: BookingNewActions }

export const MAX_TESTS = 20;
const TEST_OPTIONS = 8;
const ADDRESS_LABELS = [{ value: 'home' as const, label: 'Home' }, { value: 'work' as const, label: 'Work' }, { value: 'other' as const, label: 'Other' }];
type Errors = Record<string, string | undefined>;
const fe = (e: Errors, k: string): { error?: string } => (e[k] ? { error: e[k]! } : {});

export function BookingNew({ centres, workingCentreId, today, bookableItems, actions }: BookingNewProps) {
  const router = useRouter();
  const toast = useToast();
  const visitCentres = centres.filter((c) => !c.is_home_collection);
  const homeCentre = centres.find((c) => c.is_home_collection);
  const [patient, setPatient] = useState<PatientHit>();
  const [kind, setKind] = useState<BookingKind>('centre_visit');
  const [centreId, setCentreId] = useState<string | undefined>(visitCentres.some((c) => c.id === workingCentreId) ? workingCentreId : visitCentres[0]?.id);
  const [date, setDate] = useState<string | undefined>(today);
  const [slots, setSlots] = useState<StaffSlot[]>([]);
  const [slot, setSlot] = useState<string>();
  const [tests, setTests] = useState<StaffBookableItem[]>([]);
  // The kit Combobox is single-value: the last pick is its value (keeps the list closed after a pick); the chosen list is `tests`.
  const [lastTest, setLastTest] = useState<StaffBookableItem>();
  const [addr, setAddr] = useState<{ label: HomeAddressInput['label']; text: string; landmark: string; municipality: string; ward?: number | undefined; district: string }>({ label: 'home', text: '', landmark: '', municipality: '', district: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  const slotCentre = kind === 'centre_visit' ? centreId : homeCentre?.id;
  useEffect(() => {
    let live = true;
    setSlot(undefined);
    if (!slotCentre || !date) { setSlots([]); return; }
    actions.listSlots({ centre_id: slotCentre, booking_kind: kind, date }).then((s) => { if (live) setSlots(s); }, () => { if (live) { setSlots([]); setFailure('Slots could not be loaded. Try again.'); } });
    return () => { live = false; };
  }, [actions, slotCentre, kind, date]);

  const chosen = new Set(tests.map((t) => t.orderable_id));
  const findTests = async (q: string) => {
    if (tests.length >= MAX_TESTS) return [];
    const s = q.trim().toLowerCase();
    const hits = bookableItems.filter((i) => i.is_active && i.booking_kinds.includes(kind) && !chosen.has(i.orderable_id) && (i.display_name.toLowerCase().includes(s) || i.code.toLowerCase().includes(s)));
    // Exact code/name matches first; a short list keeps typing fast (refine the query to see more).
    const exact = (i: StaffBookableItem) => (i.code.toLowerCase() === s || i.display_name.toLowerCase() === s ? 0 : 1);
    return hits.sort((a, b) => exact(a) - exact(b)).slice(0, TEST_OPTIONS);
  };

  const submit = async () => {
    if (busy) return;
    const e: Errors = {
      patient: patient ? undefined : 'Choose a patient',
      centre: kind === 'centre_visit' && !centreId ? 'Choose a centre' : undefined,
      date: date ? undefined : 'Choose a date',
      slot: slot ? undefined : 'Choose a slot',
      tests: tests.length ? undefined : 'Add at least one test',
      address: kind === 'home_collection' && !addr.text.trim() ? 'Enter the address' : kind === 'home_collection' && addr.text.length > 300 ? 'Address must be 300 characters or fewer' : undefined,
      ward: addr.ward !== undefined && (addr.ward < 1 || addr.ward > 99) ? 'Ward no. must be between 1 and 99' : undefined,
    };
    if (kind === 'centre_visit') e['address'] = e['ward'] = undefined;
    setErrors(e);
    const missing = Object.values(e).filter(Boolean);
    if (missing.length) { setFailure(`Check the form: ${missing.join('; ')}.`); return; }
    const body: CreateBookingBody = {
      patient_id: patient!.id, booking_kind: kind, ...(slotCentre ? { centre_id: slotCentre } : {}), slot_start: slot!, orderable_ids: tests.map((t) => t.orderable_id),
      ...(kind === 'home_collection'
        ? { home_address: {
            label: addr.label, address_text: addr.text.trim(),
            ...(addr.landmark.trim() ? { landmark: addr.landmark.trim() } : {}), ...(addr.municipality.trim() ? { municipality: addr.municipality.trim() } : {}),
            ...(addr.ward !== undefined ? { ward_no: addr.ward } : {}), ...(addr.district.trim() ? { district: addr.district.trim() } : {}),
          } }
        : {}),
    };
    setFailure(undefined);
    setBusy(true);
    try {
      const b = await actions.create(body);
      toast.show({ tone: 'success', title: `Booking ${b.booking_no} created` });
      router.push(`/engagement/bookings/${encodeURIComponent(b.id)}`);
    } catch (err) {
      setFailure(bookingProblem(err));
      setBusy(false);
    }
  };
  // Capture phase: the kit inputs handle Enter themselves; Ctrl+Enter must reach the form first.
  const onKeyDownCapture = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); void submit(); }
  };

  return (
    <form className="lims-form lims-stack" noValidate onSubmit={(ev) => { ev.preventDefault(); void submit(); }} onKeyDownCapture={onKeyDownCapture}>
      <Combobox<PatientHit>
        label="Patient" name="patient_id" isRequired minChars={3} value={patient} onChange={setPatient} {...fe(errors, 'patient')}
        loadOptions={(q) => actions.searchPatients(q)} getKey={(p) => p.id} renderValue={(p) => p.name}
        renderOption={(p) => `${p.name} · ${p.patient_code} · ${p.age} / ${p.sex}`}
      />
      <RadioGroup label="Type" name="booking_kind" orientation="horizontal" value={kind} onChange={(k) => { setKind(k); setTests((t) => t.filter((i) => i.booking_kinds.includes(k))); }} options={KIND_OPTIONS} />
      {kind === 'centre_visit' ? (
        <Select label="Centre" name="centre_id" isRequired options={visitCentres.map((c) => ({ value: c.id, label: c.display_name }))} {...(centreId ? { value: centreId } : {})} onChange={setCentreId} {...fe(errors, 'centre')} />
      ) : (
        <fieldset className="lims-fieldset">
          <legend>Collection address</legend>
          <Select label="Label" name="address_label" options={ADDRESS_LABELS} value={addr.label} onChange={(v) => setAddr((a) => ({ ...a, label: v }))} />
          <TextArea label="Address" name="address_text" isRequired maxLength={300} value={addr.text} onChange={(v) => setAddr((a) => ({ ...a, text: v }))} {...fe(errors, 'address')} />
          <TextField label="Landmark" name="landmark" maxLength={120} value={addr.landmark} onChange={(v) => setAddr((a) => ({ ...a, landmark: v }))} />
          <TextField label="Municipality" name="municipality" maxLength={80} value={addr.municipality} onChange={(v) => setAddr((a) => ({ ...a, municipality: v }))} />
          <IntegerField label="Ward no." name="ward_no" min={1} max={99} {...(addr.ward !== undefined ? { value: addr.ward } : {})} onChange={(v) => setAddr((a) => ({ ...a, ward: v }))} {...fe(errors, 'ward')} />
          <TextField label="District" name="district" maxLength={60} value={addr.district} onChange={(v) => setAddr((a) => ({ ...a, district: v }))} />
        </fieldset>
      )}
      <DatePicker label="Date" name="date" isRequired min={today as IsoDate} value={date as IsoDate | undefined} onChange={setDate} {...fe(errors, 'date')} />
      <Select
        label="Slot" name="slot_start" isRequired placeholder={slots.length ? 'Choose a slot' : 'No slots on this date'}
        options={slots.map((s) => ({ value: s.slot_start, label: `${hhmm(s.slot_start)} — ${s.remaining} of ${s.capacity} left`, isDisabled: s.overbooked || s.remaining <= 0 }))}
        {...(slot ? { value: slot } : {})} onChange={setSlot} {...fe(errors, 'slot')}
      />
      <Combobox<StaffBookableItem>
        label="Tests" name="orderable_ids" value={lastTest} {...fe(errors, 'tests')}
        description={tests.length >= MAX_TESTS ? `At most ${MAX_TESTS} tests per booking.` : `Up to ${MAX_TESTS} tests.`}
        loadOptions={findTests} getKey={(i) => i.orderable_id} renderValue={(i) => i.display_name} renderOption={(i) => i.display_name}
        onChange={(i) => { setLastTest(i); if (i && tests.length < MAX_TESTS) setTests((t) => (t.some((x) => x.orderable_id === i.orderable_id) ? t : [...t, i])); }}
      />
      {tests.length ? (
        <ul className="lims-list" aria-label="Chosen tests">
          {tests.map((t) => (
            <li key={t.orderable_id} className="lims-inline">
              {t.display_name}
              <IconButton label={`Remove ${t.display_name}`} icon="close" onPress={() => setTests((x) => x.filter((y) => y.orderable_id !== t.orderable_id))} />
            </li>
          ))}
        </ul>
      ) : null}
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
      <div className="lims-inline">
        <Button variant="primary" shortcut="Ctrl+Enter" isLoading={busy} onPress={() => void submit()}>Create booking</Button>
      </div>
    </form>
  );
}

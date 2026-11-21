'use client';
// 04-UI-UX §3 registration page body. All API access goes through the server actions (BFF); drafts live in memory only (04-UI-UX §1: no browser storage).
// LD-25 (2026-11-07, A33-2 downtime mode): the "Downtime back-entry" switch adds entry_mode/occurred_at/downtime_ref to F9.
// LD-310 / T0D-REGSCREEN-1 (founder request 2026-11-17 04:49 NPT): one screen, three columns (patient and billing context | tests | payment) with the
// totals bar fixed at the bottom, rare items under one More fold, and every web-only ElabAssist item on the existing contracts (no contract change).
// UI-only values (barcode, client label, patient type, registration time, franchise choice) never reach F9: they wait for T0D-REGSCREEN-2.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { IconButton } from '@lims/ui/components/IconButton';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { KeyboardShortcutsDialog } from '@lims/ui/components/KeyboardShortcutsDialog';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { useRouter } from 'next/navigation';
import {
  COUPON_RE, MAX_ITEMS, MAX_PAY_ROWS, buildDraft, draftPatient, effectivePriority, hasPayErrors, newKey, opt, parseDraftPayload, paymentsOf, plain, registerBody, rowAmount, validateDowntime, validatePayments,
  type DowntimeErrors, type Downtime, type DraftPayload, type Item, type PayErrors, type PayRow,
} from '../forms/draft';
import { SHORTCUT_GROUPS } from '../forms/shortcuts';
import { enterPicksFirst } from '../hooks/useEnterPicksFirst';
import { useQuote, type QuoteState } from '../hooks/useQuote';
import { useShortcuts } from '../hooks/useShortcuts';
import {
  addFavouriteAction, createDraftAction, createRegistrationAction, deleteDraftAction, getDiscountApprovalAction, getPatientRewardsAction, listCustomFieldDefinitionsAction,
  listDiscountReasonsAction, listFavouritesAction, listIcdCodesAction, listPaymentMethodsAction, listTestNamesAction, previewNumbersAction, removeFavouriteAction,
  requestDiscountApprovalAction, searchCreditPartiesAction, searchDoctorsAction, searchOrderablesAction, searchPatientsAction, uploadRegistrationTrfAction,
} from '../server/actions';
import type { Centre, CodedSetEntry, CreditPartySummary, CustomFieldDefinition, DoctorSummary, DraftDiscount, IcdCode, NewPatientDraft, NumberPreview, OrderableSummary, PatientSummary, RegistrationResult } from '../server/types';
import { DiscountDialog } from './DiscountDialog';
import { DraftsDialog } from './DraftsDialog';
import { NewPatientForm } from './NewPatientForm';
import { AddClientDialog, AddDoctorDialog, KIND_LABEL } from './QuickAdd';
import { SuccessPanel, type OfflineSaved } from './SuccessPanel';
// T0D-OFFLINE-3 (LD-322; done_when 1, 5): offline the form searches, prices and registers from the encrypted cache (core/offline/flows.ts)
import { isOnline, useOfflineFlows, useOfflineSnapshot } from '@/core/offline/ui/OfflineProvider';
import { BlockWarning } from '@/core/offline/ui/OfflineParts';
import { OfflineError } from '@/core/offline/store';
import type { Quote, RegistrationDraft } from '../server/types';
import type { ReceiptDocument } from '@/features/billing/server/types';
import './frontdesk.css';
import { t } from '@/core/i18n/messages';

export interface RegistrationFormProps {
  centres: readonly Centre[];
  permissions: readonly string[];
  defaultCentreId?: string | undefined;
  /** Tenant's current consent text version for new patients; no operation exposes it to front_desk yet (open point in FD-T13-impl). */
  consentTextVersion?: string;
}

const COLLECTION = [{ value: 'walk_in', label: 'Walk-in' }, { value: 'centre', label: 'Centre' }, { value: 'home', label: 'Home' }, { value: 'partner', label: 'Partner' }] as const;
const SEARCH_BY = [{ value: 'name', label: 'Name' }, { value: 'code', label: 'Short name' }, { value: 'both', label: 'Both' }] as const;
const TRF_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const KIND: Record<string, string> = { test: 'Test', panel: 'Panel' };
const npr = (paisa: number): Money => ({ amountPaisa: paisa, currency: 'NPR' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUSY = 'Billing is busy, press Ctrl+Enter to retry';
const CREDIT = 'Credit party is locked / over limit — choose Cash or contact finance';
const PCT = 'Enter a percent between 0 and 100';
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kathmandu' }) : '');
const fmtNow = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** UI-only barcode until T0D-REGSCREEN-2 stores it on the order (specimen barcodes still come from C5 label printing). */
const genBarcode = () => `R${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')}`;

type BannerState = { tone: 'warning' | 'danger'; title: string } | null;
type Approval = { id: string; status: string } | null;
type SearchBy = (typeof SEARCH_BY)[number]['value'];

export function RegistrationForm(props: RegistrationFormProps) {
  const [generation, setGeneration] = useState(0);
  if (!props.permissions.includes('frontdesk.registration.create')) {
    return <p role="alert">You need registration permission to use this page. Ask your administrator.</p>;
  }
  return <Registration key={generation} {...props} onReset={() => setGeneration((g) => g + 1)} />;
}

function Registration({ centres, permissions, defaultCentreId, consentTextVersion = '1', onReset }: RegistrationFormProps & { onReset: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const root = useRef<HTMLElement>(null);
  const moreId = useId();
  const focusField = (f: string) => root.current?.querySelector<HTMLElement>(`[data-field="${f}"] input`)?.focus();
  const canAddClient = permissions.includes('catalog.price_list.manage'); // createCreditParty x-permission; the server enforces
  const canAddDoctor = permissions.includes('catalog.referrer.manage'); // createDoctor quick add x-permission; the server enforces

  // Laboratory = centres that are not franchises; a chosen Franchise centre wins as centre_id (LD-310 / T0D-REGSCREEN-1).
  const labs = centres.filter((c) => c.kind !== 'franchise');
  const franchises = centres.filter((c) => c.kind === 'franchise');
  const def = centres.find((c) => c.id === defaultCentreId);
  const [labId, setLabId] = useState(def && def.kind !== 'franchise' ? def.id : labs[0]?.id ?? '');
  const [franchiseId, setFranchiseId] = useState(def?.kind === 'franchise' ? def.id : '');
  const centreId = franchiseId || labId;
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [newPatient, setNewPatient] = useState<NewPatientDraft | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [visit, setVisit] = useState<'opd' | 'ipd'>('opd');
  const [billing, setBilling] = useState<'cash' | 'credit'>('cash');
  const [party, setParty] = useState<CreditPartySummary>();
  const [clientLabel, setClientLabel] = useState('');
  const [referrer, setReferrer] = useState<DoctorSummary>();
  const [collection, setCollection] = useState<string>('walk_in');
  const [urgentAll, setUrgentAll] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [discounts, setDiscounts] = useState<DraftDiscount[]>([]);
  const [billPct, setBillPct] = useState<number>();
  const [billAmt, setBillAmt] = useState<number>();
  const [linePct, setLinePct] = useState<Record<string, number | undefined>>({});
  const [reasons, setReasons] = useState<CodedSetEntry[]>([]);
  const [rows, setRows] = useState<PayRow[]>([{ id: 0, method: 'cash', amountTouched: false, reference: '' }]);
  const [methods, setMethods] = useState<CodedSetEntry[]>([]);
  const [dt, setDt] = useState<Downtime>({ on: false, ref: '' });
  const [buyerPan, setBuyerPan] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchBy, setSearchBy] = useState<SearchBy>('both');
  const [showTrf, setShowTrf] = useState(false);
  const [trfIds, setTrfIds] = useState<string[]>([]);
  const [barcode, setBarcode] = useState<string>();
  const [now, setNow] = useState(() => new Date());
  const [payErr, setPayErr] = useState<PayErrors>({ amount: {}, reference: {}, tendered: {} });
  const [dtErr, setDtErr] = useState<DowntimeErrors>({});
  const [fieldErr, setFieldErr] = useState<{ referrer?: string; clientLabel?: string }>({});
  const [banner, setBanner] = useState<BannerState>(null);
  const [approval, setApproval] = useState<Approval>(null);
  const [result, setResult] = useState<RegistrationResult | null>(null);
  const [savedOffline, setSavedOffline] = useState<OfflineSaved>();
  const flows = useOfflineFlows();
  const offSnap = useOfflineSnapshot();
  const offline = !!flows?.registerOrder && !!offSnap && !isOnline(offSnap);
  const [submitting, setSubmitting] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const [dialog, setDialog] = useState<'none' | 'discount' | 'shortcuts' | 'zero' | 'discard' | 'client' | 'doctor'>('none');
  const [testKey, setTestKey] = useState(0); // remount the test search after each add: clears its text, keeps focus
  const [patientKey, setPatientKey] = useState(0);
  // LD-310 / T0D-REGSCREEN-2: the backend backed ElabAssist items (T0B-REGAPI-1/2).
  const [preview, setPreview] = useState<NumberPreview>();
  const [icdMaster, setIcdMaster] = useState<IcdCode[]>([]);
  const [customDefs, setCustomDefs] = useState<CustomFieldDefinition[]>([]);
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [known, setKnown] = useState<Record<string, OrderableSummary>>({}); // id -> summary for favourites names (cart, search results, C3 tests list)
  const [testTab, setTestTab] = useState<'all' | 'favourites'>('all');
  const [rewards, setRewards] = useState<number>();
  const [redeem, setRedeem] = useState<number>();
  const [couponText, setCouponText] = useState('');
  const [coupon, setCoupon] = useState<string>();
  const [couponErr, setCouponErr] = useState<string>();
  const [visitingPaisa, setVisitingPaisa] = useState<number>();
  const [collectionAt, setCollectionAt] = useState<string>();
  const [collectedBy, setCollectedBy] = useState('');
  const [notCollected, setNotCollected] = useState(false);
  const [sampleRemark, setSampleRemark] = useState('');
  const [texts, setTexts] = useState({ clinical: '', history: '', mr: '', extRef: '', insCode: '' }); // health text (D-27a): F9 only
  const [claimPaisa, setClaimPaisa] = useState<number>();
  const [orderErr, setOrderErr] = useState<{ collectionAt?: string; sampleRemark?: string }>({});
  const [openedDraft, setOpenedDraft] = useState<string>();
  const [draftsOpen, setDraftsOpen] = useState(false);
  const submitting_ = useRef(false);
  const rowId = useRef(0);
  const sentKey = useRef<{ hash: string; key: string } | null>(null);
  const retryLabels = useRef<(() => void) | null>(null);
  const wantFocus = useRef<string | null>('patient');
  const refocusPatient = useRef(false);
  const trfPending = useRef<Promise<unknown>>(Promise.resolve());
  const trfIdsRef = useRef<string[]>([]);

  // Inline discounts (registration and test level) join the F6 dialog discounts; invalid values stay in the field and are never sent.
  const reason = reasons[0]?.code ?? 'discount';
  const pctOk = (p?: number) => p !== undefined && p > 0 && p <= 100;
  const inline: DraftDiscount[] = [
    ...(pctOk(billPct) ? [{ scope: 'bill' as const, kind: 'percent' as const, percent_bp: billPct! * 100, reason_code: reason }] : []),
    ...(billAmt && billAmt >= 1 ? [{ scope: 'bill' as const, kind: 'amount' as const, amount_paisa: billAmt, reason_code: reason }] : []),
    ...items.flatMap((i) => (pctOk(linePct[i.orderable.id]) ? [{ scope: 'line' as const, kind: 'percent' as const, orderable_id: i.orderable.id, percent_bp: linePct[i.orderable.id]! * 100, reason_code: reason }] : [])),
  ];
  const allDiscounts = [...discounts, ...inline];

  const redeemOk = redeem !== undefined && redeem > 0 && rewards !== undefined && redeem <= rewards;
  const ds = {
    centreId, patient, newPatient, visit, billing, ...(party ? { creditPartyId: party.id } : {}), ...(referrer ? { referrerId: referrer.id } : {}), collection, urgentAll, items, discounts: allDiscounts,
    ...(coupon ? { coupon } : {}), ...(visitingPaisa ? { visitingPaisa } : {}), ...(redeemOk ? { redeemPoints: redeem } : {}),
  };
  const draft = buildDraft(ds);
  const offlineQuote = async (d: RegistrationDraft) => {
    const q = await flows!.quote!(d);
    if (!q.ok) return { ok: false as const, code: q.code, title: q.code === 'catalog.no_price' ? 'A test has no price in the price list kept on this device' : 'Prices could not be calculated' };
    const m = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
    const data = {
      lines: [], totals: { gross: m(q.gross_paisa), discount: m(q.discount_paisa), exempt: m(0), taxable: m(0), vat: m(0), other_tax: m(0), net: m(q.net_paisa) },
      discount_evaluation: { ...q.discount_evaluation, limit_paisa: Math.floor((q.gross_paisa * q.discount_evaluation.limit_percent_bp) / 10_000) },
      quote_fingerprint: q.quote_fingerprint, base_fingerprint: q.quote_fingerprint,
    } as unknown as Quote;
    return { ok: true as const, data };
  };
  const onlineQuote = useQuote(offline ? null : draft); // offline the cached price list quotes instead (same 'ready' gate on Register)
  const [offQs, setOffQs] = useState<QuoteState>({ status: 'idle' });
  const [offNonce, setOffNonce] = useState(0);
  const draftKey = draft ? JSON.stringify(draft) : '';
  useEffect(() => {
    if (!offline || !draft) { setOffQs({ status: 'idle' }); return; }
    let gone = false;
    setOffQs({ status: 'pending' });
    void offlineQuote(draft).catch(() => ({ ok: false as const, code: 'common.internal', title: 'Prices could not be calculated' }))
      .then((r) => { if (!gone) setOffQs(r.ok ? { status: 'ready', quote: r.data } : { status: 'error', code: r.code, title: r.title }); });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draftKey stands for draft
  }, [offline, draftKey, offNonce]);
  const qs = offline ? offQs : onlineQuote.state;
  const refresh = offline ? () => setOffNonce((n) => n + 1) : onlineQuote.refresh;
  const quote = qs.status === 'ready' ? qs.quote : null;
  const net = quote?.totals.net.amount_paisa ?? 0;
  const creditState = billing === 'credit' ? quote?.credit_status?.state : undefined;
  const needsApproval = !!quote?.discount_evaluation.approval_required;
  const requiresReference = (m: string) => !!methods.find((x) => x.code === m)?.requires_reference;
  const patientType = billing === 'cash' ? 'Walk-in (cash)' : party ? (KIND_LABEL[party.kind ?? ''] ?? 'Credit client') : 'Credit — choose a party';

  useLayoutEffect(() => { // focus requested by an action that remounts or reveals a field
    const f = wantFocus.current;
    if (f) { wantFocus.current = null; focusField(f); }
    if (refocusPatient.current) { refocusPatient.current = false; if (document.activeElement === document.body) focusField('patient'); } // only if the cashier has not moved on (the remount dropped focus)
  });
  useEffect(() => { void listPaymentMethodsAction().then((r) => { if (r.ok) setMethods(r.data); }); }, []);
  useEffect(() => { void listDiscountReasonsAction().then((r) => { if (r.ok) setReasons([...r.data].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))); }); }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setBanner(null); }, [JSON.stringify(draft)]); // eslint-disable-line react-hooks/exhaustive-deps
  // LD-310 / T0D-REGSCREEN-2 reads. Each is quiet on failure: the screen works without it (no alert, no error page).
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    if (centreId) void previewNumbersAction(centreId).then((r) => { if (live && r.ok) setPreview(r.data); });
    return () => { live = false; };
  }, [centreId]);
  useEffect(() => { void listFavouritesAction().then((r) => { if (r.ok) setFavs(new Set(r.data)); }); }, []);
  const icdLoaded = useRef(false);
  useEffect(() => { // lazily: only once a test is in the cart
    if (items.length === 0 || icdLoaded.current) return;
    icdLoaded.current = true;
    void listIcdCodesAction().then((r) => { if (r.ok) setIcdMaster(r.data.filter((c) => c.is_active)); });
  }, [items.length]);
  const defsLoaded = useRef(false);
  useEffect(() => {
    if (!showNew || defsLoaded.current) return;
    defsLoaded.current = true;
    void listCustomFieldDefinitionsAction().then((r) => { if (r.ok) setCustomDefs(r.data.filter((d) => d.is_active)); });
  }, [showNew]);
  const canReadPatient = permissions.includes('frontdesk.patient.read'); // getPatientRewards x-permission
  useEffect(() => {
    let live = true;
    setRewards(undefined); setRedeem(undefined);
    if (patient && canReadPatient) void getPatientRewardsAction(patient.id).then((r) => { if (live && r.ok) setRewards(r.data.balance_points); });
    return () => { live = false; };
  }, [patient?.id, canReadPatient]); // eslint-disable-line react-hooks/exhaustive-deps
  const namesLoaded = useRef(false);
  useEffect(() => { // favourites carry only ids: names come from what this screen has seen, then from the C3 tests list once
    if (testTab !== 'favourites' || namesLoaded.current || [...favs].every((id) => known[id])) return;
    namesLoaded.current = true;
    void listTestNamesAction().then((list) => setKnown((k) => ({ ...Object.fromEntries(list.map((o) => [o.id, o])), ...k })));
  }, [testTab, favs, known]);
  const remember = (os: readonly OrderableSummary[]) => { if (os.some((o) => !known[o.id])) setKnown((k) => ({ ...k, ...Object.fromEntries(os.map((o) => [o.id, o])) })); };

  useEffect(() => { // approval wait: poll every 3 s through the BFF (04-UI-UX §1)
    if (approval?.status !== 'pending') return;
    const t = setInterval(() => {
      void getDiscountApprovalAction(approval.id).then((r) => { if (r.ok) setApproval({ id: approval.id, status: r.data.status ?? r.data.state ?? 'pending' }); });
    }, 3000);
    return () => clearInterval(t);
  }, [approval]);

  const clearPay = () => setPayErr({ amount: {}, reference: {}, tendered: {} });
  const patchRow = (i: number, p: Partial<PayRow>) => { clearPay(); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r))); };

  const addItem = (o: OrderableSummary | undefined) => {
    if (!o) return;
    if (items.some((i) => i.orderable.id === o.id)) toast.show({ tone: 'warning', title: 'Already added' });
    else if (items.length >= MAX_ITEMS) toast.show({ tone: 'warning', title: `At most ${MAX_ITEMS} tests per registration` });
    else { setItems((xs) => [...xs, { orderable: o }]); remember([o]); }
    wantFocus.current = 'tests';
    setTestKey((k) => k + 1);
  };
  const setIcd = (id: string, icd: string | undefined) => setItems((xs) => xs.map((i) => (i.orderable.id === id ? { ...i, ...(icd ? { icd } : { icd: undefined as never }) } : i)));
  const icdToAll = (icd: string | undefined) => { if (icd) setItems((xs) => xs.map((i) => ({ ...i, icd }))); };
  const loadIcd = async (q: string) => {
    const t = q.trim().toLowerCase();
    return icdMaster.filter((c) => c.code.toLowerCase().startsWith(t) || c.description.toLowerCase().includes(t)).slice(0, 20);
  };
  /** Star toggle: optimistic, reverted (and said) when the API refuses. */
  const toggleFav = async (id: string) => {
    const on = !favs.has(id);
    const flip = (v: boolean) => setFavs((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });
    flip(on);
    const r = on ? await addFavouriteAction(id, newKey()) : await removeFavouriteAction(id);
    if (!r.ok) { flip(!on); toast.show({ tone: 'danger', title: 'Could not save the favourite' }); }
  };
  const applyCoupon = () => {
    const c = couponText.trim().toUpperCase();
    if (!COUPON_RE.test(c)) { setCouponErr('Enter a valid coupon code: letters, digits, - and _ (at most 32)'); return; }
    setCouponErr(undefined); setCouponText(c); setCoupon(c);
  };
  const removeItem = (id: string) => {
    setItems((xs) => xs.filter((i) => i.orderable.id !== id)); setDiscounts((ds_) => ds_.filter((d) => d.orderable_id !== id));
    setLinePct((m) => { const n = { ...m }; delete n[id]; return n; }); focusField('tests');
  };
  const toggleUrgent = (id: string) => setItems((xs) => xs.map((i) => (i.orderable.id === id ? { ...i, priority: effectivePriority(i, urgentAll) === 'urgent' ? 'routine' : 'urgent' } : i)));
  const addRow = () => {
    if (rows.length >= MAX_PAY_ROWS) return;
    const used = new Set(rows.map((r) => r.method));
    const method = methods.find((m) => !used.has(m.code))?.code ?? methods[0]?.code ?? 'cash';
    clearPay();
    setRows((rs) => [...rs, { id: ++rowId.current, method, amountTouched: true, reference: '' }]);
  };

  const validQuery = (q: string) => {
    const t = q.trim();
    const digits = t.replace(/\D/g, '');
    return [...t].length >= 3 || (digits.length >= 10 && /^[\d\s+-]+$/.test(t)); // patient_search_min_chars 3, or 10+ digits
  };
  const loadPatients = async (q: string) => {
    const t = q.trim();
    if (!validQuery(t)) { setNoMatch(false); return []; }
    const r = offline ? { ok: true as const, data: (await flows!.searchPatients!(t)) as PatientSummary[] } : await searchPatientsAction(t);
    const data = r.ok ? r.data : [];
    setNoMatch(r.ok && data.length === 0);
    return data;
  };
  /** Enter before the list has loaded searches now (no debounce) and takes the first hit, like a scanner's trailing Enter (04-UI-UX §3.2 A). */
  const onPatientKey = (e: KeyboardEvent<HTMLElement>) => {
    const input = e.target as HTMLInputElement;
    const listed = input.getAttribute('aria-expanded') === 'true' && !!document.getElementById(input.getAttribute('aria-controls') ?? '')?.querySelector('[role="option"]');
    if (e.key !== 'Enter' || input.tagName !== 'INPUT' || listed || !validQuery(input.value) || input.value === patient?.full_name) return enterPicksFirst(e);
    e.preventDefault();
    e.stopPropagation();
    void searchPatientsAction(input.value.trim()).then((r) => {
      const hit = r.ok ? r.data[0] : undefined;
      setNoMatch(r.ok && !hit);
      if (hit) { pickPatient(hit); setPatientKey((k) => k + 1); refocusPatient.current = true; }
    });
  };
  /** Search tests by Name, Short name (code) or Both: the API matches both; the choice narrows the list here. */
  const loadOrderables = async (q: string) => {
    const r = offline ? { ok: true as const, data: (await flows!.searchTests!(q)) as OrderableSummary[] } : await searchOrderablesAction(q);
    const t = q.trim().toLowerCase();
    const data = r.ok ? r.data : [];
    remember(data);
    return searchBy === 'both' ? data : data.filter((o) => (searchBy === 'name' ? o.name : o.code).toLowerCase().includes(t));
  };
  const loadDoctors = async (q: string) => { const r = await searchDoctorsAction(q); return r.ok ? r.data : []; };
  const loadParties = async (q: string) => { const r = await searchCreditPartiesAction(q); return r.ok ? r.data : []; };
  const findExisting = useRef(async (mobile: string) => { const r = await searchPatientsAction(mobile); return r.ok ? r.data : []; }).current;

  const openNewPatient = () => { setShowNew(true); setNoMatch(false); setTimeout(() => root.current?.querySelector<HTMLElement>('input[name="full_name"]')?.focus(), 0); };
  const closeNewPatient = () => { setShowNew(false); setPatientKey((k) => k + 1); wantFocus.current = 'patient'; };
  const pickPatient = (p: PatientSummary | undefined) => { setPatient(p ?? null); setNewPatient(null); setNoMatch(false); };
  const pickParty = (p: CreditPartySummary | undefined) => { setParty(p); setClientLabel(p?.name ?? ''); setFieldErr((e) => ({ ...e, clientLabel: undefined as never })); };
  const reveal = (f: 'barcode' | 'trf', shown: boolean, show: () => void) => { if (shown) focusField(f); else { wantFocus.current = f; show(); } };
  const revealBarcode = () => reveal('barcode', barcode !== undefined, () => setBarcode(''));
  const openTrf = () => reveal('trf', showTrf, () => setShowTrf(true));

  const uploadTrf = (files: readonly File[]) => {
    trfIdsRef.current = []; setTrfIds([]);
    trfPending.current = Promise.all(files.map(async (f) => {
      const form = new FormData();
      form.set('file', f);
      const r = await uploadRegistrationTrfAction(centreId, form, newKey());
      if (r.ok) { trfIdsRef.current = [...trfIdsRef.current, r.data.id]; setTrfIds(trfIdsRef.current); }
      else toast.show({ tone: 'danger', title: `${f.name} could not be uploaded` });
    }));
  };

  /** Profile photo: the TRF upload operation (multipart file + centre_id, no order_id); the id rides as new_patient.profile_photo_attachment_id. */
  const uploadPhoto = async (f: File) => {
    const form = new FormData();
    form.set('file', f);
    const r = await uploadRegistrationTrfAction(centreId, form, newKey());
    if (r.ok) return r.data.id;
    toast.show({ tone: 'danger', title: 'The photo could not be uploaded' });
    return undefined;
  };

  // Drafts (LD-310 / T0D-REGSCREEN-2): kept on the server for 14 days, never in the browser. The payload is minimal (see DraftPayload).
  const canDraft = !!(patient || newPatient || items.length) && !!centreId && !result;
  const saveDraft = async () => {
    if (!canDraft) return;
    const payload: DraftPayload = {
      ...(patient ? { patient: { patient_id: patient.id } } : newPatient ? { patient: { new_patient: draftPatient(newPatient) } } : {}),
      centre_id: centreId, visit_type: visit, collection_mode: collection, ...(urgentAll ? { priority: 'urgent' as const } : {}),
      items: items.map((i) => ({ ...i.orderable, ...(i.priority ? { priority: i.priority } : {}), ...(i.icd ? { icd_code: i.icd } : {}) })),
      ...(coupon ? { coupon_code: coupon } : {}), ...(visitingPaisa ? { visiting_charge_paisa: visitingPaisa } : {}),
      ...opt('collected_by_name', collectedBy), ...opt('mr_number', texts.mr), ...opt('external_reference', texts.extRef), ...opt('insurance_code', texts.insCode),
    };
    // the payload holds the orderable as {id, code, name, kind}: rename id -> orderable_id for the contract shape
    const text = JSON.stringify({ ...payload, items: payload.items.map(({ id, ...rest }) => ({ orderable_id: id, ...rest })) });
    const r = await createDraftAction(centreId, text, newKey());
    toast.show(r.ok ? { tone: 'success', title: 'Draft saved' } : { tone: 'danger', title: r.title ?? 'The draft could not be saved' });
  };
  const restoreDraft = async (p: DraftPayload, draftId: string, patientOf: (id: string) => Promise<PatientSummary | undefined>) => {
    let who: PatientSummary | undefined;
    if (p.patient && 'patient_id' in p.patient) { who = await patientOf(p.patient.patient_id); if (!who) return false; }
    setPatient(who ?? null);
    setNewPatient(p.patient && 'new_patient' in p.patient ? p.patient.new_patient : null);
    setShowNew(false); setPatientKey((k) => k + 1);
    const c = centres.find((x) => x.id === p.centre_id);
    if (c) { if (c.kind === 'franchise') setFranchiseId(c.id); else { setLabId(c.id); setFranchiseId(''); } }
    if (p.visit_type) setVisit(p.visit_type);
    if (p.collection_mode) setCollection(p.collection_mode);
    setUrgentAll(p.priority === 'urgent');
    const restored = p.items.slice(0, MAX_ITEMS).map(({ priority, icd_code, ...o }) => ({ orderable: o, ...(priority ? { priority } : {}), ...(icd_code ? { icd: icd_code } : {}) }));
    setItems(restored); remember(restored.map((i) => i.orderable));
    setCoupon(p.coupon_code); setCouponText(p.coupon_code ?? ''); setVisitingPaisa(p.visiting_charge_paisa);
    setCollectedBy(p.collected_by_name ?? '');
    setTexts((t) => ({ ...t, mr: p.mr_number ?? '', extRef: p.external_reference ?? '', insCode: p.insurance_code ?? '' }));
    setOpenedDraft(draftId);
    return true;
  };

  const blocked = dialog !== 'none';
  const canRegister = qs.status === 'ready' && !submitting && !result && !!centreId && creditState !== 'locked' && creditState !== 'over_limit'; // approval is enforced by F9 (403 frontdesk.discount_approval_required)

  const fail = (code: string, title: string | undefined, errors?: { path: string; code: string }[]) => {
    switch (code) {
      case 'sync.offline_not_allowed': setBanner({ tone: 'warning', title: 'Coupons, reward points, TRF upload and discount approval need an internet connection.' }); return;
      case 'catalog.no_price': setBanner({ tone: 'danger', title: 'A test has no price in the price list kept on this device' }); return;
      case 'common.validation_failed': setBanner({ tone: 'danger', title: 'Check the order: tests, centre, patient and payments.' }); return;
      case 'common.version_conflict': setBanner({ tone: 'warning', title: 'Prices changed since you added tests. Review and register again.' }); refresh(); return;
      case 'frontdesk.patient_duplicate_suspected': setBanner({ tone: 'warning', title: 'A patient with the same name, age and mobile may already exist. Search for them before creating a new patient.' }); return;
      case 'frontdesk.discount_approval_required': setBanner({ tone: 'warning', title: 'Approval needed before this discount can be used' }); return;
      case 'frontdesk.consent_required': setBanner({ tone: 'danger', title: 'Patient consent to processing is required' }); return;
      case 'frontdesk.discount_exceeds_limit': setBanner({ tone: 'danger', title: 'The discount is above your limit' }); return;
      case 'billing.credit_party_locked': case 'billing.credit_limit_exceeded': setBanner({ tone: 'danger', title: CREDIT }); return;
      case 'billing.counter_busy': setBanner({ tone: 'warning', title: BUSY }); return;
      case 'frontdesk.referrer_required': setFieldErr({ referrer: 'A referrer is required — choose a referring doctor' }); wantFocus.current = 'referrer'; return;
      case 'billing.payment_exceeds_due': {
        const m = /\/payments\/(\d+)\//.exec(errors?.[0]?.path ?? '');
        setPayErr({ amount: { [m ? Number(m[1]) : 0]: 'Payment is more than the amount due' }, reference: {}, tendered: {} });
        wantFocus.current = `amount-${m ? Number(m[1]) : 0}`;
        return;
      }
      default: setBanner({ tone: 'danger', title: title ?? 'Registration failed. Try again.' });
    }
  };

  const doRegister = async () => {
    if (!draft || !quote || submitting_.current) return;
    submitting_.current = true;
    setSubmitting(true);
    setBanner(null);
    try {
      await trfPending.current; // a TRF still uploading joins this registration
      const pan = buyerPan.trim();
      const trf = trfIdsRef.current;
      const order = {
        ...(collectionAt ? { collection_at: new Date(collectionAt).toISOString() } : {}), ...opt('collected_by_name', collectedBy),
        ...(notCollected ? { sample_not_collected: true, ...opt('sample_remark', sampleRemark) } : {}),
        ...opt('clinical_history', texts.clinical), ...opt('patient_history', texts.history), ...opt('mr_number', texts.mr), ...opt('external_reference', texts.extRef),
        ...opt('insurance_code', texts.insCode), ...(claimPaisa ? { insurance_claim_amount_paisa: claimPaisa } : {}),
      };
      const body = { ...registerBody(draft, quote, rows, dt, approval?.status === 'approved' ? approval.id : undefined, newPatient, order), ...(pan ? { buyer_pan: pan } : {}), ...(trf.length ? { trf_attachment_ids: trf } : {}) };
      if (offline) { // one local record plus one outbox operation; the same refusal codes as F9
        try {
          const o = await flows!.registerOrder!(body);
          const issued = new Date().toISOString();
          const pays = (body.payments ?? []) as { method_code: string; amount_received_paisa: number }[];
          setSavedOffline({
            lab_codes: o.lab_codes, ...(o.patient_code ? { patient_code: o.patient_code } : {}),
            receipts: o.receipt_nos.map((no, i) => ({ receipt_no: no, issued_at: issued, invoice_nos: [o.invoice_no], method_code: pays[i]!.method_code, amount: { amount_paisa: pays[i]!.amount_received_paisa, currency: 'NPR' } }) as ReceiptDocument),
          });
          setResult({ order: { id: o.order_local_id, registration_no: '', status: 'pending_sync', billing_mode: billing }, invoice: { id: o.op_id, invoice_no: o.invoice_no, status: 'provisional' } });
        } catch (e) { fail(e instanceof OfflineError ? e.code : 'common.internal', undefined); }
        return;
      }
      const hash = JSON.stringify(body);
      if (sentKey.current?.hash !== hash) sentKey.current = { hash, key: newKey() }; // one key per draft: same body → same key on every retry
      const key = sentKey.current.key;
      let r = await createRegistrationAction(body, key);
      if (!r.ok && r.code === 'billing.counter_busy') { await sleep(400); r = await createRegistrationAction(body, key); } // one automatic retry, same key
      if (r.ok) {
        setResult(r.data);
        if (openedDraft) void deleteDraftAction(openedDraft); // a registered draft does not linger
      } else fail(r.code, r.title, r.errors);
    } finally {
      submitting_.current = false;
      setSubmitting(false);
    }
  };

  const submit = () => {
    if (!canRegister || submitting_.current) return;
    const pe = billing === 'cash' ? validatePayments(rows, net, requiresReference) : { amount: {}, reference: {}, tendered: {} };
    const de = validateDowntime(dt);
    const labelMissing = billing === 'credit' && clientLabel.trim() === '';
    const oe = {
      ...(collectionAt && Date.parse(collectionAt) > Date.now() ? { collectionAt: 'The collection time cannot be in the future' } : {}),
      ...(notCollected && !sampleRemark.trim() ? { sampleRemark: 'Enter the sample remark' } : {}),
    };
    const overRedeem = redeem !== undefined && rewards !== undefined && redeem > rewards;
    setPayErr(pe); setDtErr(de); setOrderErr(oe); setFieldErr(labelMissing ? { clientLabel: 'Enter the client label' } : {});
    if (de.occurredAt || de.ref) setMoreOpen(true); // the downtime fields live in the More fold
    if (hasPayErrors(pe) || de.occurredAt || de.ref || labelMissing || oe.collectionAt || oe.sampleRemark || overRedeem) {
      const i = Object.keys(pe.amount)[0];
      if (labelMissing) focusField('client-label');
      else if (i !== undefined) focusField(`amount-${i}`);
      return;
    }
    if (billing === 'cash' && net > 0 && paymentsOf(rows, net).length === 0) { setDialog('zero'); return; }
    void doRegister();
  };

  const requestApproval = async () => {
    if (!quote || !needsApproval || result) return;
    if (!patient) { toast.show({ tone: 'warning', title: 'Select the patient before requesting approval' }); return; }
    const r = await requestDiscountApprovalAction({ centre_id: centreId, base_fingerprint: quote.base_fingerprint, discounts: allDiscounts, reason_code: allDiscounts[0]?.reason_code ?? 'discount', patient_id: patient.id }, newKey());
    if (r.ok) setApproval({ id: r.data.id, status: 'pending' });
    else setBanner({ tone: 'danger', title: r.title ?? 'Approval could not be requested' });
  };

  const startNew = () => { if (result || (!patient && !newPatient && items.length === 0)) onReset(); else setDialog('discard'); };
  const openOrder = () => { if (result) router.push(`/frontdesk/orders/${result.order.id}`); };
  const openDoctor = () => { if (result) return; if (canAddDoctor) setDialog('doctor'); else toast.show({ tone: 'neutral', title: 'Adding a doctor needs the referrer manage permission' }); };

  useShortcuts(blocked ? {} : {
    F2: () => { if (showNew) closeNewPatient(); else focusField('patient'); },
    'Alt+N': () => { if (!result) openNewPatient(); },
    F3: () => focusField('referrer'),
    'Alt+D': openDoctor,
    F4: () => focusField('tests'),
    'Alt+R': () => { if (!result) setUrgentAll((v) => !v); },
    'Alt+O': () => { if (!result) setVisit('opd'); },
    'Alt+I': () => { if (!result) setVisit('ipd'); },
    'Alt+C': () => { if (!result) setBilling((b) => (b === 'cash' ? 'credit' : 'cash')); },
    F6: () => { if (!result && items.length > 0) setDialog('discount'); },
    'Alt+A': () => void requestApproval(),
    F8: () => focusField('amount-0'),
    'Alt+P': () => { if (!result && billing === 'cash') addRow(); },
    'Alt+U': () => { if (!result) openTrf(); },
    'Ctrl+Enter': submit,
    'Ctrl+Shift+N': startNew,
    'Alt+L': () => retryLabels.current?.(),
    'Alt+G': openOrder,
    '?': () => setDialog('shortcuts'),
  });

  const rowKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return; // typing in the row's discount field
    if (e.key === 'Delete') { e.preventDefault(); removeItem(id); }
    else if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); toggleUrgent(id); }
  };
  const lineOf = (id: string) => quote?.lines.find((l) => l.orderable_id === id);
  const sum = rows.reduce((a, r, i) => a + rowAmount(r, i, net), 0);
  const paidNow = billing === 'cash' ? sum : 0;
  // Summary amounts are a mirror of the Bill/Payment panels: split into two spans so the existing single-match text queries (fd-t13) still find the Bill panel value once.
  const sumMoney = (paisa: number) => <span className="lims-money"><span>Rs.</span> <span>{plain(paisa)}</span></span>;
  const total = (label: string, m?: { amount_paisa: number }) => (m ? <div key={label} className="lims-total-row"><dt className="lims-label">{label}</dt><dd><MoneyText value={npr(m.amount_paisa)} /></dd></div> : null);
  const sumRow = (label: string, paisa: number, cls = '') => <div className={`lims-reg-summary-row ${cls}`.trim()}><dt>{label}</dt><dd>{sumMoney(paisa)}</dd></div>;

  return (
    <section ref={root} aria-label="New registration" className="lims-reg">
      <PageHeader
        title={t('frontdesk.nav.registration_new')}
        helpKey="frontdesk.registration"
        actions={<Button variant="ghost" shortcut="?" onPress={() => setDialog('shortcuts')}>Shortcuts</Button>}
      />
      <div role="alert">
        {banner ? <Banner tone={banner.tone} title={banner.title} /> : null}
        {centres.length === 0 ? <Banner tone="danger" title="No centre is available to you. Ask your administrator to assign one." /> : null}
        {qs.status === 'error' ? (
          <Banner tone="danger" title={qs.code === 'catalog.tax_config_missing' ? `Tax rate for ${items.map((i) => i.orderable.code).join(', ')} is not configured in the catalog — contact finance` : qs.title ?? 'Prices could not be calculated'} />
        ) : null}
        {creditState === 'locked' || creditState === 'over_limit' ? <Banner tone="danger" title={CREDIT} /> : null}
      </div>
      <BlockWarning series="lab_code" />
      {newPatient ? <BlockWarning series="patient_id" /> : null}

      {result ? (
        <SuccessPanel result={result} onNew={onReset} onOpenOrder={openOrder} retryLabelsRef={retryLabels} {...(savedOffline ? { offline: savedOffline } : {})} />
      ) : (
        <>
          {/* LD-310 / T0D-REGSCREEN-1: three columns at >= 1280 px (context | tests | payment); the totals bar follows, fixed at the bottom. */}
          <div className="lims-reg-layout">
            <div data-reg-column="context" className="lims-reg-col">
              <Card title="Patient">
                <div className="lims-reg-section">
                  {showNew ? (
                    <NewPatientForm consentTextVersion={consentTextVersion} onCancel={closeNewPatient} onUse={(p) => { setNewPatient(p); setPatient(null); closeNewPatient(); }}
                      findExisting={findExisting} onUseExisting={(p) => { pickPatient(p); closeNewPatient(); }} customFields={customDefs} uploadPhoto={uploadPhoto} />
                  ) : (
                    <>
                      <div data-field="patient" onKeyDownCapture={onPatientKey}>
                        <Combobox<PatientSummary> key={patientKey} label="Search patient name, mobile or code" name="patient_search" debounceMs={250} loadOptions={loadPatients} getKey={(p) => p.id} renderValue={(p) => p.full_name}
                          {...(patient ? { value: patient } : {})} onChange={pickPatient}
                          renderOption={(p) => <span><strong>{p.patient_code}</strong> {p.full_name} · {p.sex} · {p.age_display}{p.phone_masked ? ` · ${p.phone_masked}` : ''}{p.last_visit_at ? ` · last visit ${fmtDate(p.last_visit_at)}` : ''}</span>} />
                      </div>
                      {noMatch ? <p role="status">No patients found. Press Alt+N to add a new patient.</p> : null}
                      {patient ? <p><strong>{patient.patient_code}</strong> <span>{patient.full_name}</span> · {patient.sex} · {patient.age_display}{patient.phone_masked ? ` · ${patient.phone_masked}` : ''}</p> : null}
                      {newPatient ? <p>New patient: <strong>{newPatient.full_name}</strong></p> : null}
                      <Button variant="ghost" onPress={openNewPatient}>New patient</Button>
                    </>
                  )}
                  <div className="lims-reg-pair">
                    <RadioGroup label="Visit type" name="visit_type" orientation="horizontal" value={visit} onChange={setVisit} options={[{ value: 'opd', label: 'OPD' }, { value: 'ipd', label: 'IPD' }]} />
                    <TextField label="Patient type" name="patient_type" maxLength={60} isReadOnly value={patientType} />
                  </div>
                  <div className="lims-reg-pair">
                    <div data-field="referrer" onKeyDownCapture={enterPicksFirst} className="lims-reg-grow">
                      <Combobox<DoctorSummary> label="Referrer" name="referrer" loadOptions={loadDoctors} getKey={(d) => d.id} renderValue={(d) => d.display_name} {...(referrer ? { value: referrer } : {})}
                        onChange={(d) => { setReferrer(d); setFieldErr({}); }} {...(fieldErr.referrer ? { error: fieldErr.referrer } : {})}
                        renderOption={(d) => <span>{d.display_name}{d.doctor_code ? ` (${d.doctor_code})` : ''}</span>} />
                    </div>
                    {canAddDoctor ? <Button variant="ghost" iconStart="plus" shortcut="Alt+D" onPress={openDoctor}>Add doctor</Button> : null}
                  </div>
                  {!referrer ? <Badge>Self</Badge> : null}
                  <div className="lims-reg-pair">
                    <Select label="Collection mode" name="collection_mode" value={collection} onChange={setCollection} options={COLLECTION} />
                    <Switch label="Urgent order (Alt+R)" isSelected={urgentAll} onChange={setUrgentAll} />
                  </div>
                  <div className="lims-reg-pair">
                    <Select label="Laboratory" name="centre" value={labId} onChange={setLabId} options={labs.map((c) => ({ value: c.id, label: c.name }))} isDisabled={labs.length < 2} />
                    <Select label="Franchise centre" name="franchise_centre" value={franchiseId} onChange={setFranchiseId} isDisabled={franchises.length === 0}
                      options={[{ value: '', label: 'None' }, ...franchises.map((c) => ({ value: c.id, label: c.name }))]} />
                  </div>
                  <TextField label="Registration date and time" name="registration_at" maxLength={40} isReadOnly value={fmtNow(now)} />
                  {/* LD-310 / T0D-REGSCREEN-2: a preview only (previewRegistrationNumbers consumes no counter); the real numbers are assigned on save */}
                  <div className="lims-reg-pair">
                    <TextField label="Next lab number" name="next_lab_number" maxLength={32} isReadOnly value={preview?.next_registration_no ?? ''} />
                    <TextField label="Next bill receipt number" name="next_receipt_number" maxLength={64} isReadOnly value={preview?.next_receipt_no ?? ''} />
                  </div>
                  {preview ? <p className="lims-reg-hint">{preview.next_receipt_no_label}</p> : null}
                  <button type="button" className="lims-reg-more" aria-expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen((o) => !o)}>More {moreOpen ? '▴' : '▾'}</button>
                  <div id={moreId} hidden={!moreOpen} className="lims-reg-section lims-reg-fold">
                    <TextArea label="Clinical history" name="clinical_history" maxLength={4000} rows={2} showCount={false} value={texts.clinical} onChange={(v) => setTexts((t) => ({ ...t, clinical: v }))} />
                    <TextArea label="Patient history" name="patient_history" maxLength={4000} rows={2} showCount={false} value={texts.history} onChange={(v) => setTexts((t) => ({ ...t, history: v }))} />
                    <div className="lims-reg-pair">
                      <TextField label="MR number" name="mr_number" maxLength={64} value={texts.mr} onChange={(v) => setTexts((t) => ({ ...t, mr: v }))} />
                      <TextField label="External reference" name="external_reference" maxLength={64} value={texts.extRef} onChange={(v) => setTexts((t) => ({ ...t, extRef: v }))} />
                    </div>
                    <div className="lims-reg-pair">
                      <TextField label="Insurance code" name="insurance_code" maxLength={64} value={texts.insCode} onChange={(v) => setTexts((t) => ({ ...t, insCode: v }))} />
                      <MoneyField label="Insurance claim amount" name="insurance_claim_amount" {...(claimPaisa !== undefined ? { value: npr(claimPaisa) } : {})} onChange={(m) => setClaimPaisa(m?.amountPaisa)} />
                    </div>
                    <TextField label="Buyer PAN" name="buyer_pan" maxLength={32} inputMode="numeric" value={buyerPan} onChange={setBuyerPan} />
                    <Switch label="Downtime back-entry" isSelected={dt.on} onChange={(on) => { setDtErr({}); setDt({ on, ref: '' }); }} />
                    {dt.on ? (
                      <>
                        <DateTimePicker label="Original time" name="occurred_at" isRequired {...(dt.occurredAt ? { value: dt.occurredAt as NonNullable<DateTimePickerProps['value']> } : {})} onChange={(v) => { setDtErr((e) => ({ ...e, occurredAt: undefined as never })); setDt((d) => ({ ...d, ...(v ? { occurredAt: v } : { occurredAt: undefined as never }) })); }} {...(dtErr.occurredAt ? { error: dtErr.occurredAt } : {})} />
                        <TextField label="Paper form serial" name="downtime_ref" maxLength={32} isRequired value={dt.ref} onChange={(v) => { setDtErr((e) => ({ ...e, ref: undefined as never })); setDt((d) => ({ ...d, ref: v })); }} {...(dtErr.ref ? { error: dtErr.ref } : {})} />
                      </>
                    ) : null}
                  </div>
                </div>
              </Card>
            </div>

            <div data-reg-column="tests" className="lims-reg-col">
              <Card title="Tests">
                <div className="lims-reg-section lims-reg-fill">
                  <RadioGroup label="Search tests by" name="test_search_by" orientation="horizontal" value={searchBy} onChange={(v) => { setSearchBy(v); setTestKey((k) => k + 1); }} options={SEARCH_BY} />
                  <div role="tablist" aria-label="Test lists" className="lims-reg-tabs">
                    {(['all', 'favourites'] as const).map((tb) => (
                      <button key={tb} type="button" role="tab" id={`${moreId}-tab-${tb}`} aria-selected={testTab === tb} aria-controls={tb === 'favourites' ? `${moreId}-favs` : undefined} className="lims-reg-tab" onClick={() => setTestTab(tb)}>
                        {tb === 'all' ? 'All tests' : 'Favourites'}
                      </button>
                    ))}
                  </div>
                  <div data-field="tests" onKeyDownCapture={enterPicksFirst}>
                    <Combobox<OrderableSummary> key={testKey} label="Search tests or packages" name="test_search" debounceMs={150} loadOptions={loadOrderables} getKey={(o) => o.id} renderValue={(o) => o.name} onChange={addItem}
                      renderOption={(o) => <span><strong>{o.code}</strong> {o.name} <small>{KIND[o.kind] ?? o.kind}</small></span>} />
                  </div>
                  {testTab === 'favourites' ? (
                    <div role="tabpanel" id={`${moreId}-favs`} aria-labelledby={`${moreId}-tab-favourites`} className="lims-reg-favs">
                      {favs.size === 0 ? <p className="lims-reg-hint">No favourite tests yet. Star a test in the cart to add it.</p> : (
                        <div role="list" aria-label="Favourite tests" className="lims-reg-fav-list">
                          {[...favs].flatMap((id) => (known[id] ? [known[id]] : [])).map((o) => (
                            <div role="listitem" key={o.id}><button type="button" className="lims-reg-fav" onClick={() => addItem(o)}><strong>{o.code}</strong> {o.name}</button></div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                  <div className="lims-reg-tests-list">
                    {items.length === 0 ? <p>No tests selected yet. Press F4 to search.</p> : (
                      <table aria-label="Selected tests">
                        <thead><tr><th scope="col"><VisuallyHidden>Favourite</VisuallyHidden></th><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Priority</th><th scope="col">Price</th><th scope="col">Surcharge</th><th scope="col">Disc. %</th><th scope="col">ICD code</th><th scope="col"><VisuallyHidden>Remove</VisuallyHidden></th></tr></thead>
                        <tbody>
                          {items.map((i) => {
                            const l = lineOf(i.orderable.id);
                            const p = linePct[i.orderable.id];
                            return (
                              <tr key={i.orderable.id} tabIndex={0} onKeyDown={(e) => rowKey(e, i.orderable.id)}>
                                <td>
                                  <button type="button" className="lims-reg-star" aria-pressed={favs.has(i.orderable.id)} aria-label={`Favourite ${i.orderable.code}`} onClick={() => void toggleFav(i.orderable.id)}>
                                    <span aria-hidden="true">{favs.has(i.orderable.id) ? '★' : '☆'}</span>
                                  </button>
                                </td>
                                <td>{i.orderable.code}</td><td>{i.orderable.name}</td><td>{KIND[i.orderable.kind] ?? i.orderable.kind}</td>
                                <td>{effectivePriority(i, urgentAll) === 'urgent' ? 'Urgent' : 'Routine'}</td>
                                <td>{l ? plain(l.unit_price.amount_paisa) : '—'}</td><td>—</td>
                                <td className="lims-reg-cell-field">
                                  <IntegerField label={`${i.orderable.code} discount percent`} name={`line_discount_${i.orderable.code}`} min={0} max={100} {...(p !== undefined ? { value: p } : {})}
                                    onChange={(v) => setLinePct((m) => ({ ...m, [i.orderable.id]: v }))} {...(p !== undefined && p > 100 ? { error: PCT } : {})} />
                                </td>
                                <td className="lims-reg-cell-field lims-reg-cell-icd">
                                  {/* ICD master codes only (free text that is not in the master is not accepted: the combobox commits a picked option only) */}
                                  <Combobox<IcdCode> label={`${i.orderable.code} ICD code`} name={`icd_${i.orderable.code}`} loadOptions={loadIcd} getKey={(c) => c.code} renderValue={(c) => c.code}
                                    {...(i.icd ? { value: icdMaster.find((c) => c.code === i.icd) ?? { id: i.icd, code: i.icd, description: '', is_active: true } } : {})}
                                    onChange={(c) => setIcd(i.orderable.id, c?.code)} renderOption={(c) => <span><strong>{c.code}</strong> {c.description}</span>} />
                                  <IconButton label={`Apply ${i.orderable.code} ICD code to all`} icon="copy" onPress={() => icdToAll(i.icd)} />
                                </td>
                                <td><IconButton label={`Remove ${i.orderable.code}`} icon="close" onPress={() => removeItem(i.orderable.id)} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div className="lims-reg-pair">
                    <DateTimePicker label="Collection date and time" name="collection_at" {...(collectionAt ? { value: collectionAt as NonNullable<DateTimePickerProps['value']> } : {})}
                      onChange={(v) => { setOrderErr((e) => ({ ...e, collectionAt: undefined as never })); setCollectionAt(v ?? undefined); }} {...(orderErr.collectionAt ? { error: orderErr.collectionAt } : {})} />
                    <TextField label="Collected by" name="collected_by_name" maxLength={200} value={collectedBy} onChange={setCollectedBy} />
                  </div>
                  <Switch label="Sample not collected" isSelected={notCollected} onChange={(v) => { setNotCollected(v); setOrderErr((e) => ({ ...e, sampleRemark: undefined as never })); }} />
                  {notCollected ? (
                    <TextField label="Sample remark" name="sample_remark" maxLength={500} isRequired value={sampleRemark} onChange={(v) => { setSampleRemark(v); setOrderErr((e) => ({ ...e, sampleRemark: undefined as never })); }} {...(orderErr.sampleRemark ? { error: orderErr.sampleRemark } : {})} />
                  ) : null}
                  <div className="lims-reg-pair">
                    <Button variant="ghost" shortcut="Alt+U" onPress={openTrf}>Upload TRF</Button>
                    <Button variant="ghost" onPress={() => { wantFocus.current = 'barcode'; setBarcode(genBarcode()); }}>Generate barcode</Button>
                    <Button variant="ghost" onPress={revealBarcode}>Capture barcode</Button>
                    <Button variant="ghost" onPress={revealBarcode}>Type barcode</Button>
                  </div>
                  {showTrf ? (
                    <div data-field="trf">
                      <FileUpload label="TRF file" name="trf_file" accept={TRF_TYPES} multiple maxFiles={5} onSelect={uploadTrf} description={trfIds.length ? `${trfIds.length} attached` : 'PDF, JPEG or PNG'} />
                    </div>
                  ) : null}
                  {barcode !== undefined ? (
                    <div data-field="barcode">
                      <TextField label="Barcode" name="barcode" maxLength={32} value={barcode} onChange={setBarcode} description="Scan or type; printed labels still come from label printing" />
                    </div>
                  ) : null}
                </div>
              </Card>
            </div>

            <div data-reg-column="payment" className="lims-reg-col">
              <Card title="Billing">
                <div className="lims-reg-section">
                  <RadioGroup label="Billing mode" name="billing_mode" orientation="horizontal" value={billing} onChange={setBilling} options={[{ value: 'cash', label: 'Cash' }, { value: 'credit', label: 'Credit' }]} />
                  {billing === 'credit' ? (
                    <>
                      <div className="lims-reg-pair">
                        <div data-field="credit" onKeyDownCapture={enterPicksFirst} className="lims-reg-grow">
                          <Combobox<CreditPartySummary> label="Credit party" name="credit_party" loadOptions={loadParties} getKey={(p) => p.id} renderValue={(p) => p.name} {...(party ? { value: party } : {})} onChange={pickParty}
                            renderOption={(p) => <span>{p.name}{p.party_code ? ` (${p.party_code})` : ''}</span>} />
                        </div>
                        {canAddClient ? <Button variant="ghost" iconStart="plus" onPress={() => setDialog('client')}>Add client</Button> : null}
                      </div>
                      <div data-field="client-label">
                        <TextField label="Client label" name="client_label" maxLength={160} isRequired value={clientLabel} onChange={(v) => { setClientLabel(v); setFieldErr((e) => ({ ...e, clientLabel: undefined as never })); }} {...(fieldErr.clientLabel ? { error: fieldErr.clientLabel } : {})} />
                      </div>
                      {party?.credit_limit_paisa !== undefined || party?.outstanding ? (
                        <dl className="lims-reg-credit">
                          {party.credit_limit_paisa !== undefined ? <div className="lims-total-row"><dt className="lims-label">Credit limit</dt><dd><MoneyText value={npr(party.credit_limit_paisa)} /></dd></div> : null}
                          {party.outstanding ? <div className="lims-total-row"><dt className="lims-label">Consumed</dt><dd><MoneyText value={npr(party.outstanding.amount_paisa)} /></dd></div> : null}
                        </dl>
                      ) : null}
                      {creditState ? <p>Credit status: <Badge tone={creditState === 'ok' ? 'success' : 'danger'}>{creditState === 'ok' ? 'OK' : creditState === 'locked' ? 'Locked' : 'Over limit'}</Badge></p> : null}
                    </>
                  ) : null}
                  <div role="status" aria-live="polite">
                    {qs.status === 'pending' ? (<><p>Prices updating…</p><LoadingSkeleton variant="detail" rows={3} /></>) : null}
                    {quote ? (
                      <>
                        <table aria-label="Bill lines">
                          <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Unit price</th><th scope="col">Discount</th><th scope="col">Tax</th><th scope="col">Net</th></tr></thead>
                          <tbody>
                            {quote.lines.map((l) => (
                              <tr key={l.line_ref}><td>{l.code}</td><td>{l.name}</td><td>{plain(l.unit_price.amount_paisa)}</td><td>{plain(l.discount.amount_paisa)}</td><td>{plain(l.vat.amount_paisa + l.other_tax.amount_paisa)}</td><td>{plain(l.net.amount_paisa)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                        <dl>
                          {total('Gross', quote.totals.gross)}{total('Discount', quote.totals.discount)}{total('Exempt', quote.totals.exempt)}{total('Taxable', quote.totals.taxable)}
                          {total('VAT', quote.totals.vat)}{total('Other tax', quote.totals.other_tax)}
                          <div className="lims-total-row lims-total-net"><dt className="lims-label">Net</dt><dd><MoneyText value={npr(net)} /></dd></div>
                        </dl>
                      </>
                    ) : null}
                  </div>
                  <div className="lims-reg-pair">
                    <IntegerField label="Discount percent" name="bill_discount_percent" min={0} max={100} {...(billPct !== undefined ? { value: billPct } : {})} onChange={setBillPct} {...(billPct !== undefined && billPct > 100 ? { error: PCT } : {})} />
                    <MoneyField label="Discount amount" name="bill_discount_amount" {...(billAmt !== undefined ? { value: npr(billAmt) } : {})} onChange={(m) => setBillAmt(m?.amountPaisa)} />
                  </div>
                  {discounts.length ? (
                    <div role="list" aria-label="Applied discounts">
                      {discounts.map((d, i) => (
                        <div role="listitem" key={i}>{d.kind === 'percent' ? `${(d.percent_bp ?? 0) / 100}%` : `Rs. ${plain(d.amount_paisa ?? 0)}`} {d.scope === 'line' ? 'on a line' : 'on the bill'} — {d.reason_code}{' '}
                          <IconButton label={`Remove discount ${i + 1}`} icon="close" onPress={() => { setDiscounts((x) => x.filter((_, j) => j !== i)); setApproval(null); }} /></div>
                      ))}
                    </div>
                  ) : null}
                  {needsApproval && quote ? (
                    approval ? <p role="status">Discount approval: {approval.status === 'pending' ? 'Pending' : approval.status === 'approved' ? 'Approved' : approval.status === 'rejected' ? 'Rejected' : 'Expired'}</p>
                      : <Banner tone="warning" title={`Approval needed (limit ${quote.discount_evaluation.limit_percent_bp / 100}%)`} action={{ label: 'Request approval (Alt+A)', onPress: () => void requestApproval() }} />
                  ) : null}
                  <Button variant="ghost" shortcut="F6" onPress={() => items.length > 0 && setDialog('discount')} isDisabled={items.length === 0}>Discount</Button>
                  {/* LD-310 / T0D-REGSCREEN-2: coupon (the server decides validity; front desk cannot list coupons), visiting charge, reward points */}
                  <div className="lims-reg-pair">
                    <TextField label="Coupon code" name="coupon_code" maxLength={32} value={couponText} onChange={(v) => { setCouponText(v); setCouponErr(undefined); setCoupon(undefined); }} {...(couponErr ? { error: couponErr } : {})} />
                    <Button variant="ghost" onPress={applyCoupon}>Apply coupon</Button>
                  </div>
                  {coupon && quote ? (
                    <div role="list" aria-label="Applied coupons" className="lims-reg-coupons">
                      <div role="listitem"><span>{coupon}</span> <MoneyText value={npr(quote.totals.discount.amount_paisa)} />{' '}
                        <IconButton label={`Remove coupon ${coupon}`} icon="close" onPress={() => { setCoupon(undefined); setCouponText(''); }} /></div>
                    </div>
                  ) : null}
                  <div className="lims-reg-pair">
                    <MoneyField label="Visiting charge" name="visiting_charge" {...(visitingPaisa !== undefined ? { value: npr(visitingPaisa) } : {})} onChange={(m) => setVisitingPaisa(m?.amountPaisa || undefined)} />
                    {rewards !== undefined ? (
                      <IntegerField label="Redeem points" name="redeem_reward_points" min={0} max={rewards} {...(redeem !== undefined ? { value: redeem } : {})} onChange={setRedeem}
                        {...(redeem !== undefined && redeem > rewards ? { error: `More than the balance of ${rewards} points` } : {})} />
                    ) : null}
                  </div>
                  {rewards !== undefined ? <p className="lims-reg-hint">Reward points <strong>{rewards}</strong></p> : null}
                  {billing === 'credit' ? (
                    <p>{party ? `Billed to ${party.name} monthly` : 'Choose a credit party. The bill is charged to it monthly.'}</p>
                  ) : (
                    <div role="group" aria-label="Payment rows">
                      {rows.map((r, i) => (
                        <div key={r.id} className="lims-reg-pay-row">
                          <Select label={i === 0 ? 'Method' : `Method (row ${i + 1})`} name={`method_${i}`} value={r.method} onChange={(v) => patchRow(i, { method: v, ...(v !== 'card' ? { cardHolder: undefined as never } : {}) })}
                            options={(methods.length ? methods : [{ code: 'cash', display: 'Cash' }]).map((m) => ({ value: m.code, label: m.display }))} />
                          <div data-field={`amount-${i}`}>
                            <MoneyField label={i === 0 ? 'Amount' : `Amount (row ${i + 1})`} name={`amount_${i}`} {...(rowAmount(r, i, net) > 0 || r.amountTouched === false ? { value: npr(rowAmount(r, i, net)) } : {})}
                              onChange={(m) => patchRow(i, { amountTouched: true, ...(m ? { amount: m.amountPaisa } : { amount: undefined as never }) })} {...(payErr.amount[i] ? { error: payErr.amount[i] } : {})} />
                          </div>
                          <TextField label={i === 0 ? 'Reference' : `Reference (row ${i + 1})`} name={`reference_${i}`} maxLength={100} value={r.reference} onChange={(v) => patchRow(i, { reference: v })} {...(payErr.reference[i] ? { error: payErr.reference[i] } : {})} />
                          {r.method === 'cash' ? (
                            <>
                              <MoneyField label={i === 0 ? 'Tendered' : `Tendered (row ${i + 1})`} name={`tendered_${i}`} {...(r.tendered !== undefined ? { value: npr(r.tendered) } : {})}
                                onChange={(m) => patchRow(i, { tendered: m?.amountPaisa as number })} {...(payErr.tendered[i] ? { error: payErr.tendered[i] } : {})} />
                              {r.tendered !== undefined && r.tendered >= rowAmount(r, i, net) && rowAmount(r, i, net) > 0 ? <div><span className="lims-label">Change</span> <MoneyText value={npr(r.tendered - rowAmount(r, i, net))} /></div> : null}
                            </>
                          ) : null}
                          {r.method === 'card' ? (
                            <TextField label={i === 0 ? 'Card holder name' : `Card holder name (row ${i + 1})`} name={`card_holder_${i}`} maxLength={100} autoComplete="off" value={r.cardHolder ?? ''} onChange={(v) => patchRow(i, { cardHolder: v })} />
                          ) : null}
                          <TextField label={i === 0 ? 'Payment remark' : `Payment remark (row ${i + 1})`} name={`payment_remark_${i}`} maxLength={300} value={r.remark ?? ''} onChange={(v) => patchRow(i, { remark: v })} />
                          {i > 0 ? <IconButton label={`Remove payment row ${i + 1}`} icon="close" onPress={() => { clearPay(); setRows((rs) => rs.filter((x) => x.id !== r.id)); }} /> : null}
                        </div>
                      ))}
                      <Button variant="ghost" iconStart="plus" shortcut="Alt+P" onPress={addRow} isDisabled={rows.length >= MAX_PAY_ROWS}>Add method</Button>
                      <div role="status"><span className="lims-label">Balance after payment</span> <MoneyText value={npr(Math.max(0, net - sum))} /></div>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <aside className="lims-reg-summary" aria-label="Registration summary">
            {/* T0D-UIGUARD-1-FRONTDESK (LD-436 R7): no raw h2/ul/li here; heading and list keep their roles (same pattern as the BILLING print headings). */}
            <p role="heading" aria-level={2} className="lims-reg-summary-title">Summary</p>
            <dl className="lims-reg-summary-list">
              <div className="lims-reg-summary-row">
                <dt>Tests</dt>
                <dd>{items.length === 0 ? 'None yet' : `${items.length} selected`}{items.length ? <div role="list" className="lims-reg-summary-tests">{items.map((i) => <div role="listitem" key={i.orderable.id}>{i.orderable.name}</div>)}</div> : null}</dd>
              </div>
              {sumRow('Total', net + (quote?.totals.discount.amount_paisa ?? 0))}
              {sumRow('Net', net)}
              {sumRow('Paid', paidNow)}
              {sumRow('Balance', Math.max(0, net - paidNow), 'lims-reg-summary-balance')}
              {sumRow('Refund', 0)}
              {sumRow('Billed', net)}
              <div className="lims-reg-summary-row">
                <dt>Discount authority</dt>
                <dd>{quote ? `Limit ${quote.discount_evaluation.limit_percent_bp / 100}%${needsApproval ? ' · approval required' : ''}` : '—'}</dd>
              </div>
            </dl>
            <Button variant="ghost" isDisabled={!canDraft} onPress={() => void saveDraft()}>Save as draft</Button>
            <Button variant="ghost" onPress={() => setDraftsOpen(true)}>Drafts</Button>
            <Button variant="primary" type="submit" shortcut="Ctrl+Enter" isDisabled={!canRegister} isLoading={submitting} onPress={submit}>Register &amp; print</Button>
          </aside>
        </>
      )}

      {dialog === 'discount' ? <DiscountDialog items={items} onClose={() => setDialog('none')} onApply={(d) => { setDiscounts((x) => [...x, d]); setApproval(null); setDialog('none'); }} /> : null}
      {draftsOpen ? <DraftsDialog centres={centres} onClose={() => setDraftsOpen(false)} onOpen={async (p, id, patientOf) => { const ok = await restoreDraft(p, id, patientOf); if (ok) setDraftsOpen(false); return ok; }} /> : null}
      {dialog === 'client' ? <AddClientDialog onClose={() => setDialog('none')} onSaved={(p) => { pickParty(p); setDialog('none'); }} /> : null}
      {dialog === 'doctor' ? <AddDoctorDialog onClose={() => setDialog('none')} onSaved={(d) => { setReferrer(d); setFieldErr({}); setDialog('none'); }} /> : null}
      <KeyboardShortcutsDialog isOpen={dialog === 'shortcuts'} onClose={() => setDialog('none')} groups={SHORTCUT_GROUPS} />
      <div onKeyDown={(e) => { if (dialog === 'zero' && e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setDialog('none'); void doRegister(); } }}>
        <ConfirmDialog isOpen={dialog === 'zero'} title="Register without payment?" confirmLabel="Register" onCancel={() => setDialog('none')}
          body={<p>No payment — <MoneyText value={npr(net)} /> will be due.</p>} onConfirm={() => { setDialog('none'); return doRegister(); }} />
      </div>
      <ConfirmDialog isOpen={dialog === 'discard'} title="Discard this registration?" confirmLabel="Discard" tone="danger" onCancel={() => setDialog('none')}
        body={<p>The patient, tests and payment you entered will be cleared.</p>} onConfirm={() => { setDialog('none'); onReset(); }} />
    </section>
  );
}

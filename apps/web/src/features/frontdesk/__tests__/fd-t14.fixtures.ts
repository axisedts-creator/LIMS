// FD-T14 shared synthetic fixtures (tester-owned). Shapes copied from contracts/openapi/frontdesk.yaml + billing.yaml (OrderDto, OrderFlag,
// DiscountApproval, Patient, OrderSummaryDto, PossibleDuplicate, OrderBillingDto). Synthetic data only.
export const ORIGIN = 'http://api.test';
export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const ORDER = U(1), PATIENT = U(2), CENTRE = U(3), ITEM_CBC = U(11), ITEM_LIPID = U(12), ITEM_TSH = U(13), FLAG = U(20), APPROVAL = U(30), APPROVAL_OWN = U(31), APPROVAL_EXPIRED = U(32);
export const ME = U(90), OTHER = U(91);
export const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });

export const PERM = {
  orderRead: 'frontdesk.order.read', orderEdit: 'frontdesk.order.edit', orderCancel: 'frontdesk.order.cancel',
  patientRead: 'frontdesk.patient.read', reg: 'frontdesk.registration.create', approve: 'frontdesk.discount.approve',
  trfUpload: 'frontdesk.trf.upload', anonymise: 'frontdesk.patient.anonymise',
  invRead: 'billing.invoice.read', pay: 'billing.payment.record', reprint: 'billing.invoice.reprint',
};
export const RECEPTION = [PERM.orderRead, PERM.orderEdit, PERM.orderCancel, PERM.patientRead, PERM.reg, PERM.trfUpload, PERM.invRead, PERM.pay];
export const READ_ONLY = [PERM.orderRead, PERM.patientRead];

export const cancelReasons = [{ code: 'patient_left', display: 'Patient left', sort_order: 1 }, { code: 'entered_in_error', display: 'Entered in error', sort_order: 2 }];
export const removalReasons = [{ code: 'patient_request', display: 'Patient request', sort_order: 1 }, { code: 'duplicate', display: 'Duplicate', sort_order: 2 }];
export const flagResolutions = [{ code: 'patient_recalled', display: 'Patient recalled', sort_order: 1 }, { code: 'not_required', display: 'Not required', sort_order: 2 }];

export const orderItem = (o: Record<string, unknown> = {}) => ({ id: ITEM_CBC, orderable_id: U(101), orderable_kind: 'test', code: 'CBC', name: 'Complete blood count', priority: 'routine', status: 'ordered', unit_price: npr(60000), outsourced: false, ...o });
export const order = (o: Record<string, unknown> = {}) => ({
  id: ORDER, registration_no: 'R-0001-000001', patient: { id: PATIENT, patient_code: 'P-000001', full_name: 'Demo Patient A', sex: 'female', age_at_order: '34 y' },
  branch_id: U(4), centre_id: CENTRE, visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'walk_in', status: 'registered',
  items: [orderItem(), orderItem({ id: ITEM_LIPID, orderable_id: U(102), code: 'LIPID', name: 'Lipid profile', unit_price: npr(90000) })],
  discounts: [], trf_attachments: [], flags: [], requires_credit_note: false, version: 5, ...o,
});
export const attachment = (o: Record<string, unknown> = {}) => ({ id: U(40), mime_type: 'image/jpeg', size_bytes: 120000, scan_state: 'clean', uploaded_by: { membership_id: ME, display_name: 'Synthetic Receptionist' }, original_filename: 'trf-1.jpg', created_at: '2026-11-07T04:00:00.000Z', ...o });

export const invoiceSummary = (o: Record<string, unknown> = {}) => ({ id: U(50), invoice_no: 'INV/2083-84/000042', invoice_seq: 42, fiscal_year_bs: '2083/84', invoice_kind: 'tax', status: 'issued', issued_at: '2026-11-07T04:00:00.000Z', invoice_date_bs: '2083-07-21', centre_id: CENTRE, order_id: ORDER, buyer_name: 'Synthetic Buyer', net: npr(150000), cbms_state: 'not_required', print_count: 2, ...o });
export const billing = (o: Record<string, unknown> = {}) => ({
  balance: { order_id: ORDER, invoiced: npr(150000), paid: npr(100000), credited: npr(0), balance_due: npr(50000), balance_version: 3, as_of: '2026-11-07T04:10:00.000Z' },
  eligibility: { release_eligible: false, release_basis: 'due_outstanding' },
  invoices: [invoiceSummary()], credit_notes: [],
  ledger_entries: [{ id: U(60), entry_kind: 'payment', capture_kind: 'manual', order_id: ORDER, invoice_id: U(50), method_code: 'cash', amount: npr(100000), receipt_no: 'RC/2083-84/000009', collected_by: { membership_id: ME, display_name: 'Synthetic Cashier' }, created_at: '2026-11-07T04:05:00.000Z', business_date_bs: '2083-07-21' }],
  credit_charges: [], open_credit_note_tasks: [], open_finance_review_items: [], refund_requests: [], ...o,
});

export const flag = (o: Record<string, unknown> = {}) => ({ id: FLAG, order_id: ORDER, kind: 'recollection_required', status: 'open', specimen_id: U(70), created_at: '2026-11-07T04:00:00.000Z', version: 2, ...o });
export const orderSummary = (o: Record<string, unknown> = {}) => ({ id: ORDER, registration_no: 'R-0001-000001', patient_id: PATIENT, patient_display: 'Demo Patient A', centre_id: CENTRE, status: 'registered', billing_mode: 'cash', source: 'walk_in', registered_at: '2026-11-07T04:00:00.000Z', item_count: 2, has_open_flag: true, version: 5, ...o });
export const patientSummary = (o: Record<string, unknown> = {}) => ({ id: PATIENT, patient_code: 'P-000001', full_name: 'Demo Patient A', sex: 'female', age_display: '34 y', phone_masked: '98xxxxxx42', is_anonymised: false, ...o });
export const patient = (o: Record<string, unknown> = {}) => ({
  ...patientSummary(), is_birth_on_estimated: false, phone_e164: '+9779800000042', email: 'demo.a@example.test', address_text: 'Synthetic Road 1',
  consents: { processing: true, sms: true, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'v3' }, version: 4, ...o,
});
export const patientOrders = [orderSummary({ id: U(1), registration_no: 'R-0001-000001', status: 'registered' }), orderSummary({ id: U(5), registration_no: 'R-0001-000007', status: 'cancelled', has_open_flag: false })];
export const approval = (o: Record<string, unknown> = {}) => ({
  id: APPROVAL, status: 'pending', centre_id: CENTRE, requested_by: { membership_id: OTHER, display_name: 'Synthetic Receptionist' },
  discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 3000, reason_code: 'staff_relative' }], computed_discount: npr(45000), gross: npr(150000), percent_of_gross_bp: 3000,
  reason_code: 'staff_relative', expires_at: '2026-11-07T04:15:00.000Z', version: 7, ...o,
});

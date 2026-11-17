// C6-T06 shared synthetic fixtures (no real data). Port-shaped inputs (contracts/ports/*) for the document builder tests.
// ASSUMED builder input (spec names no signature; 02-TRD §3.2 "document.ts receives already-fetched port outputs"):
//   BuildDocumentInput = { orderResults, includeOrderItemIds, orderSummary, tests, panels, demographics, referrer?, centre,
//     settings{branding,calendarDisplay,timezone}, printCriticalLabel? (top-level, C6 setting), signatories, config{signatoryMode,maxSignatories,disclaimers,nominatedMembershipIds?},
//     commentTexts?, qrVerifyUrl, reportedAt, complete, earlierReleased, regeneration?{reasonCode,reasonText?,previousVersionNo,amendedAt} }
export const id = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const I = {
  order: id(1), patient: id(2), centre: id(3), referrer: id(4),
  deptBio: id(0x10), deptHaem: id(0x11), deptClin: id(0x12),
  tGlu: id(0x20), tCbc: id(0x21), tTc: id(0x22), tHdl: id(0x23), tTg: id(0x24), tUrine: id(0x25), tRatio: id(0x26),
  pkg: id(0x30), lipid: id(0x31),
  aGlu: id(0x40), aHgb: id(0x41), aRbc: id(0x42), aWbc: id(0x43), aHct: id(0x44), aTc: id(0x45), aHdl: id(0x46), aTg: id(0x47),
  aPh: id(0x48), aProt: id(0x49), aGluc: id(0x4a), aRatio: id(0x4b),
  itemPkg: id(0x50), itemLipid: id(0x51), itemUrine: id(0x52), itemRatio: id(0x53),
  m1: id(0x60), m2: id(0x61), m3: id(0x62), m4: id(0x63),
};

const an = (aid: string, code: string, name: string, sortOrder: number, o: Record<string, unknown> = {}) =>
  ({ id: aid, code, name, resultType: 'numeric', reportable: true, sortOrder, ...o });
const test = (tid: string, code: string, name: string, dept: string, deptName: string, deptCode: string, analytes: unknown[], o: Record<string, unknown> = {}) =>
  ({ id: tid, code, name, departmentId: dept, departmentName: deptName, departmentCode: deptCode, specimenTypeCodes: ['SERUM'], workflowType: 'standard',
     analytes, isActive: true, revision: 1, ...o });

export const URINE_SET = [
  { code: 'NEG', display: 'Negative', sortOrder: 1 }, { code: 'TR', display: 'Trace', sortOrder: 2 },
  { code: '1P', display: '1+', sortOrder: 3 }, { code: '2P', display: '2+', sortOrder: 4 },
];

export const TESTS: any[] = [
  test(I.tGlu, 'GLU', 'GLUCOSE FASTING', I.deptBio, 'Biochemistry', 'BIO', [an(I.aGlu, 'GLU', 'Glucose', 1, { decimals: 1, unitCode: 'mg/dL' })], { specimenReportLabel: 'SERUM' }),
  test(I.tCbc, 'CBC', 'CBC', I.deptHaem, 'Haematology', 'HAEM', [
    an(I.aHgb, 'HGB', 'HGB', 1, { printName: 'Haemoglobin', decimals: 1, unitCode: 'g/dL', reportSubheading: 'RBC parameters' }),
    an(I.aRbc, 'RBC', 'RBC Count', 2, { decimals: 2, unitCode: '10^6/uL', reportSubheading: 'RBC parameters' }),
    an(I.aWbc, 'WBC', 'WBC Count', 3, { decimals: 0, unitCode: '/uL', reportSubheading: 'WBC parameters' }),
    an(I.aHct, 'HCTI', 'Internal hematocrit', 4, { decimals: 0, reportable: false }),
  ], { specimenReportLabel: 'EDTA WHOLE BLOOD', specimenTypeCodes: ['EDTA_BLOOD'] }),
  test(I.tTc, 'TC', 'Total Cholesterol', I.deptBio, 'Biochemistry', 'BIO', [an(I.aTc, 'TC', 'Total Cholesterol', 1, { decimals: 0, unitCode: 'mg/dL' })]),   // no label -> specimen type code
  test(I.tHdl, 'HDL', 'HDL Cholesterol', I.deptBio, 'Biochemistry', 'BIO', [an(I.aHdl, 'HDL', 'HDL Cholesterol', 1, { decimals: 0, unitCode: 'mg/dL' })], { specimenReportLabel: 'SERUM' }),
  test(I.tTg, 'TG', 'Triglycerides', I.deptBio, 'Biochemistry', 'BIO', [an(I.aTg, 'TG', 'Triglycerides', 1, { decimals: 0, unitCode: 'mg/dL' })], { specimenReportLabel: 'SERUM' }),
  test(I.tUrine, 'URE', 'URINE R/E', I.deptClin, 'Clinical Pathology', 'CLIN', [
    an(I.aPh, 'PH', 'pH', 1, { decimals: 1, reportSubheading: 'Chemical examination' }),
    an(I.aProt, 'PROT', 'Protein', 2, { resultType: 'ordinal', ordinalSetCode: 'URINE_GRADE', ordinalSetValues: URINE_SET, reportSubheading: 'Chemical examination' }),
    an(I.aGluc, 'GLUC', 'Sugar', 3, { resultType: 'ordinal', ordinalSetCode: 'URINE_GRADE', ordinalSetValues: URINE_SET, reportSubheading: 'Chemical examination' }),
  ], { specimenReportLabel: 'URINE (RANDOM)', specimenTypeCodes: ['URINE'] }),
  test(I.tRatio, 'RAT', 'BUN/CREATININE RATIO', I.deptBio, 'Biochemistry', 'BIO', [
    an(I.aRatio, 'RATIO', 'BUN/Creatinine ratio', 1, { decimals: 1, formula: { expression: 'BUN / CREAT', inputAnalyteCodes: ['BUN', 'CREAT'] } }),
  ], { specimenReportLabel: 'SERUM' }),
];

export const PANELS: any[] = [
  { id: I.pkg, code: 'PKG_BASIC', name: 'SYNTHETIC HEALTH PACKAGE (BASIC)', panelKind: 'package', members: [{ kind: 'test', id: I.tGlu }, { kind: 'test', id: I.tCbc }], isActive: true, revision: 1 },
  { id: I.lipid, code: 'LIPID', name: 'LIPID PROFILE', panelKind: 'clinical', members: [{ kind: 'test', id: I.tTc }, { kind: 'test', id: I.tHdl }, { kind: 'test', id: I.tTg }], isActive: true, revision: 1 },
];

export const SIGNATORIES: any[] = [
  { membershipId: I.m1, displayName: 'Dr. Synthetic Signatory A', displayTitle: 'MD Pathology', registrationNo: 'NMC-SYN-0001', signatureAssetId: id(0x71), signatureSha256: 'a'.repeat(64), isActive: true },
  { membershipId: I.m2, displayName: 'Dr. Synthetic Signatory B', displayTitle: 'Consultant Pathologist', registrationNo: 'NMC-SYN-0002', isActive: true },   // no signature image on file
  { membershipId: I.m3, displayName: 'Dr. Synthetic Nominee C', displayTitle: 'Lab Director', registrationNo: 'NMC-SYN-0003', signatureAssetId: id(0x73), signatureSha256: 'c'.repeat(64), isActive: true },
  { membershipId: I.m4, displayName: 'Dr. Synthetic Signatory D', displayTitle: 'Biochemist', registrationNo: 'NMC-SYN-0004', isActive: true },
];

let rn = 0;
export const res = (item: string, testId: string, analyteId: string, over: Record<string, unknown> = {}): any => ({
  resultId: id(0x1000 + ++rn), orderItemId: item, testId, analyteId, versionNo: 1, status: 'approved', origin: 'manual', commentCodes: [], attachments: [],
  onHold: false, qcReviewRequired: false, approvedAt: '2026-11-05T04:10:00.000Z', approvedByMembershipId: I.m1, ...over,
});

/** Fresh (non-shared) results per call so tests can mutate their copy. Ids are stable per analyte for goldens. */
export function makeResults() {
  const r = (item: string, t: string, a: string, n: number, o: Record<string, unknown>) => ({ ...res(item, t, a, o), resultId: id(0x1000 + n) });
  // approval order is distinct per approver (m1 04:10 < m2 04:15 < m4 04:20) so signatory order is not a tie
  return [
    { orderItemId: I.itemPkg, testId: I.tGlu, departmentId: I.deptBio, results: [
      r(I.itemPkg, I.tGlu, I.aGlu, 1, { valueNumeric: '92', unitCode: 'mg/dL', referenceRangeSnapshot: { referenceRangeId: id(0x90), version: 1, low: '70', high: '100' }, approvedByMembershipId: I.m1 })] },
    { orderItemId: I.itemPkg, testId: I.tCbc, departmentId: I.deptHaem, results: [
      r(I.itemPkg, I.tCbc, I.aHgb, 2, { valueNumeric: '17.9', flag: 'H', unitCode: 'g/dL', methodName: 'Synthetic Method X', approvedByMembershipId: I.m2, approvedAt: '2026-11-05T04:15:00.000Z',
        referenceRangeSnapshot: { referenceRangeId: id(0x91), version: 1, low: '13.0', high: '17.0' } }),
      r(I.itemPkg, I.tCbc, I.aRbc, 3, { valueNumeric: '5.1', unitCode: '10^6/uL', approvedByMembershipId: I.m2, approvedAt: '2026-11-05T04:15:00.000Z',
        referenceRangeSnapshot: { referenceRangeId: id(0x92), version: 1, low: '4.5', high: '5.9' } }),
      r(I.itemPkg, I.tCbc, I.aWbc, 4, { valueNumeric: '7400', flag: 'N', unitCode: '/uL', approvedByMembershipId: I.m2, approvedAt: '2026-11-05T04:15:00.000Z', commentCodes: ['SYN_CMT'], commentText: 'Counts verified manually.',
        referenceRangeSnapshot: { referenceRangeId: id(0x93), version: 1, text: '4000 - 11000', low: '4000', high: '11000' } }),
      r(I.itemPkg, I.tCbc, I.aHct, 5, { valueNumeric: '45', approvedByMembershipId: I.m2, approvedAt: '2026-11-05T04:15:00.000Z' })] },
    { orderItemId: I.itemLipid, testId: I.tTc, departmentId: I.deptBio, results: [
      r(I.itemLipid, I.tTc, I.aTc, 6, { valueNumeric: '182', unitCode: 'mg/dL', referenceRangeSnapshot: { referenceRangeId: id(0x94), version: 1, high: '200' }, approvedByMembershipId: I.m1 })] },
    { orderItemId: I.itemLipid, testId: I.tHdl, departmentId: I.deptBio, results: [
      r(I.itemLipid, I.tHdl, I.aHdl, 7, { valueNumeric: '38', flag: 'L', unitCode: 'mg/dL', referenceRangeSnapshot: { referenceRangeId: id(0x95), version: 1, low: '40' }, approvedByMembershipId: I.m1 })] },
    { orderItemId: I.itemLipid, testId: I.tTg, departmentId: I.deptBio, results: [
      r(I.itemLipid, I.tTg, I.aTg, 8, { valueNumeric: '310', flag: 'HH', unitCode: 'mg/dL', referenceRangeSnapshot: { referenceRangeId: id(0x96), version: 1, high: '150' }, approvedByMembershipId: I.m1 })] },
    { orderItemId: I.itemUrine, testId: I.tUrine, departmentId: I.deptClin, results: [
      r(I.itemUrine, I.tUrine, I.aPh, 9, { valueNumeric: '6.0', approvedByMembershipId: I.m1 }),
      r(I.itemUrine, I.tUrine, I.aProt, 10, { ordinalCode: '2P', flag: 'A', approvedByMembershipId: I.m1, referenceRangeSnapshot: { referenceRangeId: id(0x97), version: 1, text: 'Negative' } }),
      r(I.itemUrine, I.tUrine, I.aGluc, 11, { ordinalCode: 'NEG', approvedByMembershipId: I.m1 })] },
    { orderItemId: I.itemRatio, testId: I.tRatio, departmentId: I.deptBio, results: [
      // calculated by C5; the BUN / CREAT inputs are deliberately absent: C6 must print the stored value, never compute (TRD §4.4)
      r(I.itemRatio, I.tRatio, I.aRatio, 12, { valueNumeric: '12.5', origin: 'calculated', approvedByMembershipId: I.m4, approvedAt: '2026-11-05T04:20:00.000Z' })] },
  ];
}

export function makeInput(over: Record<string, unknown> = {}): any {
  return {
    orderResults: {
      orderId: I.order, approvedSetHash: 'h'.repeat(64),
      specimens: [{ specimenId: id(0x80), specimenTypeCode: 'EDTA_BLOOD', status: 'received', barcode: 'E2600000042',
                    collectedAt: '2026-11-05T02:25:00.000Z', receivedAt: '2026-11-05T02:55:00.000Z' }],
      items: makeResults(),
    },
    includeOrderItemIds: [I.itemPkg, I.itemLipid, I.itemUrine, I.itemRatio],
    orderSummary: {
      orderId: I.order, registrationNo: '0001SY000001', patientId: I.patient, branchId: id(5), centreId: I.centre, visitType: 'opd', billingMode: 'cash',
      priority: 'routine', status: 'completed', source: 'front_desk', registeredAt: '2026-11-05T02:17:00.000Z', version: 1,
      items: [
        { orderItemId: I.itemPkg, orderableId: I.pkg, orderableKind: 'panel', testIds: [I.tGlu, I.tCbc], priority: 'routine', status: 'active', outsourced: false },
        { orderItemId: I.itemLipid, orderableId: I.lipid, orderableKind: 'panel', testIds: [I.tTc, I.tHdl, I.tTg], priority: 'routine', status: 'active', outsourced: false },
        { orderItemId: I.itemUrine, orderableId: I.tUrine, orderableKind: 'test', testIds: [I.tUrine], priority: 'routine', status: 'active', outsourced: false },
        { orderItemId: I.itemRatio, orderableId: I.tRatio, orderableKind: 'test', testIds: [I.tRatio], priority: 'routine', status: 'active', outsourced: false },
      ],
    },
    tests: TESTS, panels: PANELS,
    demographics: { patientId: I.patient, patientCode: 'SYNP-0042', fullName: 'Test Patient 0042', sex: 'male', ageAtOrder: { years: 43, months: 0, days: 0 },
                    phoneE164: '+9779800000042', email: 'patient0042@example.invalid', consents: { sms: true, whatsapp: true, email: true, shareWithReferrer: true, consentTextVersion: 'v1' }, status: 'active' },
    centre: { code: 'C000000099', name: 'SYNTHETIC CENTRE NINETY-NINE', addressText: '1 Synthetic Road, Testville' },
    settings: {
      calendarDisplay: 'AD', timezone: 'Asia/Kathmandu',
      branding: { legalName: 'Synthetic Labs Pvt Ltd', displayName: 'Synthetic Labs', addressLines: ['1 Synthetic Road'], phones: ['+977-1-0000000'], contactEmail: 'lab@example.invalid' },
    },
    signatories: SIGNATORIES,
    config: { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: ['Synthetic disclaimer line 1.', 'Synthetic disclaimer line 2.'] },
    commentTexts: { [`${I.deptHaem}|SYN_CMT`]: 'Slide reviewed.' },   // keyed `${departmentId}|${code}` (C6-T06 review item 3)
    qrVerifyUrl: 'https://portal.example.invalid/v/AAAAAAAAAAAAAAAAAAAAAA',
    reportedAt: '2026-11-05T04:30:00.000Z',
    complete: true, earlierReleased: false,
    ...over,
  };
}

export const withItems = (...items: string[]) => makeInput({ includeOrderItemIds: items });

/** Deep-freeze: the builder must not mutate its inputs. */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); }
  return o;
}

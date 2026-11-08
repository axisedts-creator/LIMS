// ReportDocument snapshot types + pure builder (02-TRD §3.2, §4.3, §4.4, §4.5; PRD AC-02.7, AC-03.1, AC-03.6, AC-03.7; 07-SECURITY T15, P3).
// Pure: receives already-fetched port outputs, reads no clock, never mutates its input. Values are never computed here (TRD §4.4).
import { LimsError } from '../../../core/errors.js';
import { formatFlag, formatRefRange, methodLine, type FlagLabel, type ResultFlag } from './flags.js';
import { EXCLUDED_AMENDMENT_REASONS, regenerationNote, versionKind, type KindSection, type ReportKind } from './version.js';

type Uuidv7 = string;
type IsoUtc = string;

/** [CONV] mimeType optional (CR-C6-023, .orchestra/cr/C6-T06.md): signature refs are minted from IdentityPort.Signatory, which carries no mime type; the render worker reads it with the bytes. */
export type AssetRef = { source: 'branding' | 'signature' | 'narrative_image' | 'instrument_attachment' | 'module_image'; id: string; sha256: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'application/pdf' };
export interface Signatory { membershipId: Uuidv7; displayName: string; displayTitle?: string; registrationNo?: string; signatureAssetRef?: AssetRef;
  role: 'approver' | 'nominated' | 'narrative_signer' }
export interface AnalyteLine {
  analyteId: Uuidv7; resultId: Uuidv7; versionNo: number; name: string; valueText: string; flagLabel?: FlagLabel; valueBold: boolean;
  refRangeText?: string; unitText?: string; methodLine?: string; comment?: string; images: { ref: AssetRef }[];
}
export interface Block { packageName?: string; panelName: string; subgroups: { subheading?: string; lines: AnalyteLine[] }[]; specimenLine?: string; comments: string[] }
export type Section =
  | { kind: 'department'; departmentId: Uuidv7; departmentName: string; approvedBy: string[]; blocks: Block[] }
  | { kind: 'narrative'; narrativeVersionId: Uuidv7; testName: string; templateKind: string; sections: { heading: string; html: string }[];
      images: { ref: AssetRef; caption?: string }[]; signedBy: Signatory }
  | { kind: 'micro'; orderItemId: Uuidv7; testName: string; phase: 'preliminary' | 'final'; content: unknown }
  | { kind: 'anatomic'; orderItemId: Uuidv7; testName: string; content: unknown }
  | { kind: 'outsourced_index'; items: { testName: string; externalLabName: string }[] };
export type StatusLabel = 'Final' | 'Partial' | 'Preliminary' | 'Amended' | 'Addendum';
export interface AmendmentNote { analyteOrSection: string; previousVersionNo: number; reasonCode: string; reasonText?: string; amendedAt: IsoUtc }
export interface ReportDocument {
  schemaVersion: 1;
  family: 'laboratory' | 'narrative';
  reportKind: ReportKind;
  statusLabel: StatusLabel;
  lab: { displayName: string; legalName: string; addressText?: string; contactStrip: string[]; logoAssetRef?: AssetRef; headerAssetRef?: AssetRef; footerAssetRef?: AssetRef };
  header: {
    patientName: string; ageGender: string; regNo: string; barcodeNos: string[];
    sampleCollectedAt?: IsoUtc; sampleReceivedAt?: IsoUtc; registeredAt: IsoUtc; reportedAt: IsoUtc;
    referredBy: string; collectedAtCentre: { code: string; name: string; addressText?: string };
  };
  calendarDisplay: 'AD' | 'BS' | 'AD_BS' | 'BS_AD'; timezone: string;
  sections: Section[];
  amendmentNotes: AmendmentNote[];
  signatories: Signatory[];
  disclaimers: string[];
  qr: { verifyUrl: string };
  outsourcedAttachments: { inputFileId: Uuidv7; externalLabName: string; testName: string; pageCount: number; sha256: string }[];
  instrumentPdfAttachments: { analyteName: string; objectRef: AssetRef; sha256: string; sanitizedSha256: string }[];
  smart?: { summaryId: Uuidv7; templateLibraryVersion: string; payload: unknown };
}

export interface SignatoryConfig { signatoryMode: 'approvers' | 'nominated'; maxSignatories: number; disclaimers: readonly string[]; nominatedMembershipIds?: readonly string[] }
export interface Regeneration { reasonCode: string; reasonText?: string; previousVersionNo: number; amendedAt: IsoUtc }

/** Port outputs (contracts/ports/*) plus assembly inputs. `any` for port shapes: the builder reads only the documented fields. */
export interface BuildDocumentInput {
  orderResults: any;              // LabPort.OrderResults (scope approved)
  includeOrderItemIds: readonly string[];
  orderSummary: any;              // FrontdeskPort.OrderSummary
  tests: readonly any[];          // CatalogPort.TestDefinition[]
  panels: readonly any[];         // CatalogPort.PanelDefinition[]
  demographics: any;              // FrontdeskPort.PatientDemographics (purpose report_render)
  referrer?: any;                 // CatalogPort.ReferrerProfile (purpose display)
  centre: { code: string; name: string; addressText?: string };
  settings: any;                  // IdentityPort.TenantSettings (branding, calendarDisplay, timezone)
  printCriticalLabel: boolean;    // reporting.settings.print_critical_label (02-TRD §10.2)
  signatories: readonly any[];    // IdentityPort.Signatory[]
  config: SignatoryConfig;
  commentTexts?: Readonly<Record<string, string>>;   // `${departmentId}|${code}` -> resolved text
  moduleContent?: Readonly<Record<string, Record<string, unknown>>>;   // moduleKey(ref) -> row of micro./anatomic.v_pub_report_content (TRD §3.2, CR-C6-006)
  qrVerifyUrl: string;
  reportedAt: IsoUtc;
  complete: boolean;
  earlierReleased: boolean;
  regeneration?: Regeneration;
}

const STATUS: Record<ReportKind, StatusLabel> = { final: 'Final', partial: 'Partial', preliminary: 'Preliminary', amended: 'Amended', addendum: 'Addendum' };

const fail = (msg: string): never => { throw new LimsError('common.internal', msg); };

/** Key of a `ResultView.moduleRef` (LabPort) in `BuildDocumentInput.moduleContent`. */
export const moduleKey = (r: { module: string; entityId: string; versionNo: number }): string => `${r.module}|${r.entityId}|${r.versionNo}`;

/** DecimalString to `decimals` places, string arithmetic only (no float). Extra places round half-up. */
export function formatDecimal(v: string, decimals: number | undefined): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m || decimals === undefined) return v;
  const [, sign, int, frac = ''] = m;
  if (frac.length <= decimals) return decimals === 0 ? `${sign}${int}` : `${sign}${int}.${frac.padEnd(decimals, '0')}`;
  const scaled = BigInt(int + frac.slice(0, decimals)) + (Number(frac[decimals]) >= 5 ? 1n : 0n);
  const s = scaled.toString().padStart(decimals + 1, '0');
  return decimals === 0 ? `${sign}${s}` : `${sign}${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

function valueTextOf(r: any, a: any): string {
  if (r.valueNumeric !== undefined && r.valueNumeric !== null) return formatDecimal(String(r.valueNumeric), a.decimals);
  if (r.ordinalCode !== undefined) return a.ordinalSetValues?.find((o: any) => o.code === r.ordinalCode)?.display ?? r.ordinalCode;
  return r.valueText ?? '';
}

function ageGender(d: any): string {
  const { years = 0, months = 0, days = 0 } = d.ageAtOrder ?? {};
  const age = years >= 1 ? `${years} Years` : months >= 1 ? `${months} Months` : `${days} Days`;
  return `${age}/${String(d.sex ?? 'unknown').toUpperCase()}`;
}

/** Keeps the earliest approval time per membership id. */
const noteFirst = (m: Map<string, string>, id: string, at: string): void => { const prev = m.get(id); if (prev === undefined || at < prev) m.set(id, at); };

const minIso =(xs: (string | undefined)[]): string | undefined => xs.filter((x): x is string => !!x).sort()[0];

export function buildReportDocument(input: BuildDocumentInput): ReportDocument {
  const { orderResults, orderSummary, settings, config } = input;
  const testById = new Map(input.tests.map((t) => [t.id, t]));
  const panelById = new Map(input.panels.map((p) => [p.id, p]));
  const sigById = new Map(input.signatories.map((s) => [s.membershipId, s]));
  const include = new Set(input.includeOrderItemIds);
  const printCrit = input.printCriticalLabel === true;

  // Order-item order from the summary; every included id must be a known item with results (never a silently shorter report).
  const items = (orderSummary.items as any[]).filter((i) => include.has(i.orderItemId));
  if (items.length !== include.size) fail('included order item missing from the order summary');

  const departments = new Map<string, Extract<Section, { kind: 'department' }> & { approvals: Map<string, string> }>();
  const kindSections: KindSection[] = [];
  const lineNotes: AmendmentNote[] = [];
  const approvals = new Map<string, string>(); // membershipId -> first approvedAt over printed results

  for (const item of items) {
    const groups = (orderResults.items as any[]).filter((g) => g.orderItemId === item.orderItemId);
    if (groups.length === 0) fail('no results for an included order item');
    const orderable = item.orderableKind === 'panel' ? panelById.get(item.orderableId) : undefined;
    const isPackage = orderable?.panelKind === 'package';
    // panel heading per test: clinical panel -> its name; package -> nested clinical panel holding the test, else the test name.
    const panelNameFor = (test: any): string => {
      if (!orderable) return test.name;
      if (!isPackage) return orderable.name;
      const nested = (orderable.members as any[]).filter((m) => m.kind === 'panel').map((m) => panelById.get(m.id))
        .find((p) => p?.members?.some((m: any) => m.kind === 'test' && m.id === test.id));
      return nested?.name ?? test.name;
    };

    let last: { key: string; block: Block } | undefined;
    for (const testId of item.testIds as string[]) {
      const test = testById.get(testId) ?? fail('test definition missing for an included test');
      const deptId = test.departmentId as string;
      const results = groups.filter((g) => g.testId === testId).flatMap((g) => g.results as any[]).filter((r) => r.status === 'approved');
      const lines: { line: AnalyteLine; subheading?: string }[] = [];
      const approvers: [string, string][] = [];
      for (const a of [...test.analytes].sort((x: any, y: any) => x.sortOrder - y.sortOrder)) {
        if (a.reportable === false) continue;
        const r = results.find((x) => x.analyteId === a.id);
        if (!r) continue;
        const name = a.printName ?? a.name;
        const comment = [r.commentText, ...(r.commentCodes ?? []).map((c: string) => input.commentTexts?.[`${deptId}|${c}`])].filter((x) => x && String(x).trim()).join(' ');
        const range = r.referenceRangeSnapshot ? formatRefRange(r.referenceRangeSnapshot) : undefined;
        const ml = methodLine(r.methodName);
        const line: AnalyteLine = {
          analyteId: a.id, resultId: r.resultId, versionNo: r.versionNo, name, valueText: valueTextOf(r, a),
          ...formatFlag(r.flag as ResultFlag | undefined, { printCriticalLabel: printCrit }),
          ...(range !== undefined ? { refRangeText: range } : {}),
          ...(r.unitCode ? { unitText: r.unitCode } : {}),
          ...(ml !== undefined ? { methodLine: ml } : {}),
          ...(comment ? { comment } : {}),
          images: [], // instrument image attachments are resolved and sanitised by the assembly task (C6-T08)
        };
        lines.push({ line, ...(a.reportSubheading ? { subheading: a.reportSubheading } : {}) });
        if (r.amendment) {
          kindSections.push({ kind: 'lab', amendmentReason: r.amendment.reasonCode });
          if (!EXCLUDED_AMENDMENT_REASONS.has(r.amendment.reasonCode)) {
            lineNotes.push({ analyteOrSection: name, previousVersionNo: r.amendment.previousVersionNo, reasonCode: r.amendment.reasonCode,
              ...(r.amendment.reasonText !== undefined ? { reasonText: r.amendment.reasonText } : {}), amendedAt: r.amendment.amendedAt });
          }
        }
        if (r.approvedByMembershipId) approvers.push([r.approvedByMembershipId, r.approvedAt]);
      }
      if (lines.length === 0) continue;

      let dept = departments.get(deptId);
      if (!dept) { dept = { kind: 'department', departmentId: deptId, departmentName: test.departmentName, approvedBy: [], blocks: [], approvals: new Map() }; departments.set(deptId, dept); }
      for (const [m, at] of approvers) { noteFirst(approvals, m, at); noteFirst(dept.approvals, m, at); }

      const panelName = panelNameFor(test);
      const key = `${deptId}|${panelName}`;
      let block: Block;
      if (last && last.key === key && dept.blocks[dept.blocks.length - 1] === last.block) block = last.block;
      else {
        const specimen = test.specimenReportLabel ?? test.specimenTypeCodes?.[0];
        block = { ...(isPackage ? { packageName: orderable.name } : {}), panelName, subgroups: [], ...(specimen ? { specimenLine: specimen } : {}), comments: [] };
        dept.blocks.push(block); last = { key, block };
      }
      for (const { line, subheading } of lines) {
        let g = block.subgroups.find((s) => s.subheading === subheading);
        if (!g) { g = { ...(subheading !== undefined ? { subheading } : {}), lines: [] }; block.subgroups.push(g); }
        g.lines.push(line);
      }
    }
  }

  const byTime = (m: Map<string, string>) => [...m.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id);
  const sections: Section[] = [...departments.values()].map(({ approvals: ap, ...s }) => ({
    ...s, approvedBy: byTime(ap).map((id) => sigById.get(id)?.displayName).filter((n): n is string => !!n),
  }));

  // micro / anatomic: one section per distinct moduleRef of an approved result, content = the view row (never a silently shorter report if it is missing).
  const seenRefs = new Set<string>();
  for (const item of items) for (const g of (orderResults.items as any[]).filter((x) => x.orderItemId === item.orderItemId)) {
    for (const r of (g.results as any[]).filter((x) => x.status === 'approved' && (x.moduleRef?.module === 'micro' || x.moduleRef?.module === 'anatomic'))) {
      const key = moduleKey(r.moduleRef);
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      const content = input.moduleContent?.[key] ?? fail('module view row missing for an included result');
      const testName = (testById.get(g.testId) ?? fail('test definition missing for an included module result')).name;
      const amended = r.amendment ? { amendmentReason: r.amendment.reasonCode as string } : {};
      if (r.moduleRef.module === 'micro') {
        const phase = content['report_phase'] === 'preliminary' ? 'preliminary' : 'final';
        sections.push({ kind: 'micro', orderItemId: item.orderItemId, testName, phase, content });
        kindSections.push({ kind: 'micro', phase, ...amended });
      } else {
        sections.push({ kind: 'anatomic', orderItemId: item.orderItemId, testName, content });
        kindSections.push({ kind: 'anatomic', ...amended });
      }
      // 02-TRD §4.5 rule 1: a module section amended for a non-excluded reason carries an amendment note.
      if (r.amendment && !EXCLUDED_AMENDMENT_REASONS.has(r.amendment.reasonCode)) {
        lineNotes.push({ analyteOrSection: testName, previousVersionNo: r.amendment.previousVersionNo, reasonCode: r.amendment.reasonCode,
          ...(r.amendment.reasonText !== undefined ? { reasonText: r.amendment.reasonText } : {}), amendedAt: r.amendment.amendedAt });
      }
    }
  }

  const reportKind = versionKind({ ...(input.regeneration ? { regeneration: input.regeneration } : {}), earlierReleased: input.earlierReleased, sections: kindSections, complete: input.complete });
  const amendmentNotes: AmendmentNote[] = [];
  if (reportKind === 'amended') {
    const rg = input.regeneration;
    if (rg && rg.reasonCode !== 'smart_summary_added') amendmentNotes.push({ ...regenerationNote(rg.reasonCode, rg.reasonText), previousVersionNo: rg.previousVersionNo, amendedAt: rg.amendedAt });
    amendmentNotes.push(...lineNotes);
  }

  // T15: approvers mode prints only people who approved a printed result; nominated mode prints nominees known to IdentityPort.
  const toSig = (id: string, role: Signatory['role']): Signatory | undefined => {
    const s = sigById.get(id);
    if (!s) return undefined;
    return { membershipId: s.membershipId, displayName: s.displayName, ...(s.displayTitle ? { displayTitle: s.displayTitle } : {}),
      ...(s.registrationNo ? { registrationNo: s.registrationNo } : {}),
      ...(s.signatureAssetId && s.signatureSha256 ? { signatureAssetRef: { source: 'signature', id: s.signatureAssetId, sha256: s.signatureSha256 } } : {}), role };
  };
  const sigIds = config.signatoryMode === 'nominated' ? [...new Set(config.nominatedMembershipIds ?? [])] : byTime(approvals);
  const signatories = sigIds.map((id) => toSig(id, config.signatoryMode === 'nominated' ? 'nominated' : 'approver'))
    .filter((s): s is Signatory => !!s).slice(0, config.maxSignatories);

  const b = settings.branding ?? {};
  const contactStrip = [(b.phones ?? []).join(', '), b.contactEmail].filter((x): x is string => !!x).slice(0, 4);
  const specimens = (orderResults.specimens ?? []) as any[];
  const barcodes = [...new Set(specimens.map((s) => s.barcode).filter((x): x is string => !!x))];
  const collected = minIso(specimens.map((s) => s.collectedAt));
  const received = minIso(specimens.map((s) => s.receivedAt));

  return {
    schemaVersion: 1,
    family: 'laboratory',
    reportKind,
    statusLabel: STATUS[reportKind],
    lab: { displayName: b.displayName, legalName: b.legalName, ...(b.addressLines?.length ? { addressText: b.addressLines.join(', ') } : {}), contactStrip },
    header: {
      patientName: input.demographics.fullName, ageGender: ageGender(input.demographics), regNo: orderSummary.registrationNo,
      barcodeNos: barcodes.length > 3 ? [...barcodes.slice(0, 3), `+${barcodes.length - 3}`] : barcodes,
      ...(collected ? { sampleCollectedAt: collected } : {}), ...(received ? { sampleReceivedAt: received } : {}),
      registeredAt: orderSummary.registeredAt, reportedAt: input.reportedAt,
      referredBy: input.referrer?.displayName ?? 'SELF',
      collectedAtCentre: { code: input.centre.code, name: input.centre.name, ...(input.centre.addressText ? { addressText: input.centre.addressText } : {}) },
    },
    calendarDisplay: settings.calendarDisplay, timezone: settings.timezone,
    sections,
    amendmentNotes,
    signatories,
    disclaimers: [...config.disclaimers],
    qr: { verifyUrl: input.qrVerifyUrl },
    outsourcedAttachments: [],
    instrumentPdfAttachments: [],
  };
}

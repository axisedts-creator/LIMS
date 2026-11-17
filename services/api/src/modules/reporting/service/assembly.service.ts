// Reads the port outputs listed in 02-TRD §4.3 "Sources" and builds the frozen ReportDocument (domain/document.ts).
// Runs as the reporting system actor inside the assembly task; ctx is passed through to every port. Any port failure rejects (the task retries).
// Centre lookup, QR minting, smart section, instrument-PDF sanitising and the version insert belong to the assembly task (C6-T08).
import { buildReportDocument, moduleKey, type ReportDocument, type Regeneration, type SignatoryConfig } from '../domain/document.js';

export interface AssemblyCtx {
  readonly ports: {
    lab: { getOrderResults(ctx: unknown, input: { orderId: string; scope: 'approved' }): Promise<any> };
    frontdesk: {
      getOrderSummary(ctx: unknown, input: { orderId: string }): Promise<any>;
      getPatientDemographics(ctx: unknown, input: { patientId: string; purpose: 'report_render' }): Promise<any>;
    };
    catalog: {
      getTest(ctx: unknown, input: { testId: string; asOf?: string }): Promise<any>;
      getPanel(ctx: unknown, input: { panelId: string }): Promise<any>;
      getReferrer(ctx: unknown, input: { referrerId: string; purpose: 'display' }): Promise<any>;
      resolveCommentCodes(ctx: unknown, input: { codes: readonly string[]; departmentId?: string; asOf?: string }): Promise<{ resolved: { code: string; text: string }[] }>;
    };
    identity: {
      getTenantSettings(ctx: unknown, input: { keys: readonly string[] }): Promise<any>;
      getSignatories(ctx: unknown, input: { membershipIds: readonly string[] }): Promise<readonly any[]>;
    };
  };
}

export interface AssemblyInput {
  orderId: string;
  includeOrderItemIds: readonly string[];
  config: SignatoryConfig;
  centre: { code: string; name: string; addressText?: string };
  qrVerifyUrl: string;
  reportedAt: string;
  complete: boolean;
  earlierReleased: boolean;
  printCriticalLabel: boolean;   // reporting.settings.print_critical_label
  regeneration?: Regeneration;
  /** Reads micro./anatomic.v_pub_report_content rows for the moduleRefs of the approved results; returns `moduleKey(ref)` -> row. Absent -> the builder rejects a module result. */
  loadModuleContent?(refs: readonly { module: 'micro' | 'anatomic'; entityId: string; versionNo: number }[]): Promise<Record<string, Record<string, unknown>>>;
}

const SIGNATORY_BATCH = 20;    // IdentityPort.getSignatories accepts ≤ 20 ids per call
const COMMENT_BATCH = 50;      // CatalogPort.resolveCommentCodes accepts ≤ 50 codes per call

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const maxIso = (xs: readonly string[]): string | undefined => [...xs].sort().at(-1);

export async function assembleDocument(ctx: AssemblyCtx, input: AssemblyInput): Promise<ReportDocument> {
  const { lab, frontdesk, catalog, identity } = ctx.ports;
  const [orderResults, orderSummary] = await Promise.all([
    lab.getOrderResults(ctx, { orderId: input.orderId, scope: 'approved' }),
    frontdesk.getOrderSummary(ctx, { orderId: input.orderId }),
  ]);
  const include = new Set(input.includeOrderItemIds);
  const items = (orderSummary.items as any[]).filter((i) => include.has(i.orderItemId));
  // Only the included items' approved results feed anything below (P3: no other result is read into the snapshot).
  const groups = (orderResults.items as any[]).filter((g) => include.has(g.orderItemId));
  const approved = groups.flatMap((g) => (g.results as any[]).filter((r) => r.status === 'approved').map((r) => ({ g, r })));

  // CatalogPort.getTest as of the test's latest approval [CONV]; deactivated tests stay readable (no requireActive).
  const testIds = [...new Set(items.flatMap((i) => i.testIds as string[]))];
  const asOfOf = (testId: string) => maxIso(approved.filter(({ g }) => g.testId === testId).map(({ r }) => r.approvedAt).filter(Boolean));
  const testsP = Promise.all(testIds.map((testId) => { const asOf = asOfOf(testId); return catalog.getTest(ctx, { testId, ...(asOf ? { asOf } : {}) }); }));

  const panelsP = (async () => {
    const top = await Promise.all([...new Set(items.filter((i) => i.orderableKind === 'panel').map((i) => i.orderableId as string))].map((panelId) => catalog.getPanel(ctx, { panelId })));
    const nestedIds = [...new Set(top.flatMap((p) => (p?.members ?? []).filter((m: any) => m.kind === 'panel').map((m: any) => m.id as string)))];
    const nested = await Promise.all(nestedIds.map((panelId) => catalog.getPanel(ctx, { panelId })));
    return [...top, ...nested].filter(Boolean);
  })();

  // Comment codes per result group (department + approval time), batched.
  const commentsP = Promise.all(groups.flatMap((g) => {
    const rs = (g.results as any[]).filter((r) => r.status === 'approved');
    const codes = [...new Set(rs.flatMap((r) => r.commentCodes ?? []))] as string[];
    const asOf = maxIso(rs.map((r) => r.approvedAt).filter(Boolean));
    return chunks(codes, COMMENT_BATCH).map((c) => catalog.resolveCommentCodes(ctx, { codes: c, departmentId: g.departmentId, ...(asOf ? { asOf } : {}) })
      .then((res) => ({ departmentId: g.departmentId as string, resolved: res.resolved })));
  }));

  // T15: ask only for approvers of included results (+ nominees in nominated mode); image bytes are read by the render worker, not here.
  const approverIds = approved.map(({ r }) => r.approvedByMembershipId as string).filter(Boolean);
  const nominees = input.config.signatoryMode === 'nominated' ? (input.config.nominatedMembershipIds ?? []) : [];
  const sigIds = [...new Set([...nominees, ...approverIds])];
  const signatoriesP = Promise.all(chunks(sigIds, SIGNATORY_BATCH).map((ids) => identity.getSignatories(ctx, { membershipIds: ids })));

  const refs = new Map<string, { module: 'micro' | 'anatomic'; entityId: string; versionNo: number }>();
  for (const { r } of approved) if (r.moduleRef?.module === 'micro' || r.moduleRef?.module === 'anatomic') refs.set(moduleKey(r.moduleRef), r.moduleRef);
  const moduleContentP = refs.size && input.loadModuleContent ? input.loadModuleContent([...refs.values()]) : Promise.resolve(undefined);

  const [tests, panels, commentRes, sigRes, demographics, referrer, settings, moduleContent] = await Promise.all([
    testsP, panelsP, commentsP, signatoriesP,
    frontdesk.getPatientDemographics(ctx, { patientId: orderSummary.patientId, purpose: 'report_render' }),
    orderSummary.referrerId ? catalog.getReferrer(ctx, { referrerId: orderSummary.referrerId, purpose: 'display' }) : Promise.resolve(undefined),
    identity.getTenantSettings(ctx, { keys: ['branding', 'calendarDisplay', 'timezone'] }),
    moduleContentP,
  ]);

  const commentTexts: Record<string, string> = {};
  for (const res of commentRes) for (const c of res.resolved) commentTexts[`${res.departmentId}|${c.code}`] ??= c.text;

  return buildReportDocument({
    orderResults, includeOrderItemIds: input.includeOrderItemIds, orderSummary,
    tests: tests.filter(Boolean), panels, demographics, ...(referrer ? { referrer } : {}),
    centre: input.centre, settings, signatories: sigRes.flat(), config: input.config, commentTexts,
    qrVerifyUrl: input.qrVerifyUrl, reportedAt: input.reportedAt, complete: input.complete, earlierReleased: input.earlierReleased,
    printCriticalLabel: input.printCriticalLabel, ...(moduleContent ? { moduleContent } : {}),
    ...(input.regeneration ? { regeneration: input.regeneration } : {}),
  });
}

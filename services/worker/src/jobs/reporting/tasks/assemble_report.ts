// Task reporting.assemble_report (02-TRD §4.2, §4.3, §9; 01-PRD AC-02.1-02.6; 07-SECURITY T1/T3; 08 A13 P-13).
// Lock the report row (FOR UPDATE) -> readiness + fingerprint -> (new content only) build the frozen snapshot -> in ONE transaction: discard older
// unreleased versions (V1), insert the `rendering` version + QR token, refresh the report snapshots, clear needs_assembly, enqueue the render.
// Every port call, storage read and sandbox call happens BEFORE the first write, so a failure rejects (queue retry) with needs_assembly still set.
// Instrument PDFs (bucket/path pairs from the LabPort output only) go through /internal/sanitize; nothing in the reply is trusted (checkReply).
import { createHash } from 'node:crypto';
import type { TaskHandler } from '../../../core/manifest.js';
import { ENQUEUE_SQL } from '../../../core/fanout.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { moduleKey, type Section, type Signatory } from '../../../../../api/src/modules/reporting/domain/document.js';
import { fingerprint, isItemReady, outsourcedReady, shouldAssemble, type ReadyItem } from '../../../../../api/src/modules/reporting/domain/readiness.js';
import { hashToken, issueToken } from '../../../../../api/src/modules/reporting/domain/tokens.js';
import { assembleDocument } from '../../../../../api/src/modules/reporting/service/assembly.service.js';
import { checkReply, METRIC, type SandboxClient } from './process_input_file.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'reporting-inputs';
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

/** Published views, columns exactly as 03-IC §6.8 (the only micro./anatomic. objects C6 reads). */
const VIEWS = {
  micro: { name: 'micro.v_pub_report_content', jsonb: ['isolates', 'ast'],
    columns: 'tenant_id, entity_id, version_no, order_item_id, report_phase, culture_summary_text, isolates, ast, comments_text, signed_by_membership_id, signed_at' },
  anatomic: { name: 'anatomic.v_pub_report_content', jsonb: ['synoptic', 'images', 'specimen_parts', 'slides', 'ancillary', 'molecular', 'addenda', 'diagnosis_codes'],
    columns: 'tenant_id, entity_id, version_no, order_item_id, accession_no, case_kind, gross_text, microscopy_text, impression_text, synoptic, images, signed_by_membership_id, signed_at, '
      + 'version_kind, scope, change_reason_code, clinical_history_text, comment_text, specimen_parts, slides, ancillary, molecular, addenda, diagnosis_codes' },
} as const;

/** [CONV] test fixtures store the flat keys, templates.ts stores `signatories.{mode,max}`; both are read. */
function signatoryConfig(raw: unknown) {
  const c = (json(raw) ?? {}) as Row;
  return { signatoryMode: (c.signatories?.mode ?? c.signatoryMode ?? 'approvers') as 'approvers' | 'nominated', maxSignatories: Number(c.signatories?.max ?? c.maxSignatories ?? 2),
    disclaimers: (c.disclaimers ?? []) as string[], ...(c.nominatedMembershipIds ? { nominatedMembershipIds: c.nominatedMembershipIds as string[] } : {}) };
}

export function createAssembleReport(o: { sandbox: SandboxClient }): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const reportId = payload?.['report_id'];
    if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof reportId !== 'string' || !UUID.test(reportId)) {
      ctx.log?.warn?.({ event: 'assemble_report_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx; const actor: string = ctx.actor.id; const now: string = ctx.now();
    const rows = async (sql: string, values: unknown[]): Promise<Row[]> => (await tx.query(sql, values)).rows;
    const done = (event: string, extra: Row = {}) => ctx.log?.info?.({ event, report_id: reportId, ...extra });
    const clear = () => tx.query(`UPDATE reporting.reports SET needs_assembly = false, needs_assembly_since = NULL, version = version + 1, updated_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`, [tenantId, reportId, actor]);

    // 1. lock (tenant + id predicate; RLS is the second line). Concurrent tasks for the same report queue here.
    const report = (await rows(`SELECT id, centre_id, order_id, patient_id, referrer_id, partner_id, family, state, lab_approved_set_hash, regeneration_counter, latest_version_no
      FROM reporting.reports WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, reportId]))[0];
    if (!report) { ctx.log?.warn?.({ event: 'assemble_report_skipped', reason: 'unknown_report' }); return; }
    // [CONV] only the laboratory family is assembled here (document builder is laboratory-only); a cancelled report never gets a version.
    if (report.state !== 'open' || report.family !== 'laboratory') { await clear(); done('assemble_report_noop', { reason: report.state !== 'open' ? 'not_open' : 'family' }); return; }

    // 2. readiness (TRD §4.2)
    const items = (await rows(`SELECT order_item_id, test_ids, requires_lab, requires_narrative, requires_outsourced, lab_ready, narrative_ready, outsourced_ready, item_status
      FROM reporting.report_order_items WHERE tenant_id = $1 AND report_id = $2`, [tenantId, reportId])).filter((i) => i.item_status === 'active');
    const files = items.some((i) => i.requires_outsourced)
      ? await rows(`SELECT id, order_item_id, external_lab_name, page_count, sanitized_sha256 FROM reporting.input_files
          WHERE tenant_id = $1 AND order_id = $2 AND kind = 'outsourced_pdf' AND state = 'confirmed'`, [tenantId, report.order_id]) : [];
    const nreports = items.some((i) => i.requires_narrative)
      ? await rows(`SELECT id, order_item_id, test_id, template_kind, signed_version_no FROM reporting.narrative_reports WHERE tenant_id = $1 AND report_id = $2 AND status = 'signed'`, [tenantId, reportId]) : [];
    const nversions = nreports.length
      ? await rows(`SELECT id, narrative_report_id, version_no, sections, signed_by_membership_id FROM reporting.narrative_versions
          WHERE tenant_id = $1 AND narrative_report_id = ANY($2::uuid[])`, [tenantId, nreports.map((n) => n.id)]) : [];

    interface Ready { item: Row; entry: ReadyItem; file: Row | undefined; narratives: { report: Row; version: Row }[] }
    const ready: Ready[] = [];
    for (const item of items) {
      const flags = { requiresLab: item.requires_lab, requiresNarrative: item.requires_narrative, requiresOutsourced: item.requires_outsourced,
        labReady: item.lab_ready, narrativeReady: item.narrative_ready, outsourcedReady: item.outsourced_ready };
      if (!isItemReady(flags)) continue;
      const itemFiles = files.filter((f) => f.order_item_id === item.order_item_id);
      if (item.requires_outsourced && !outsourcedReady(itemFiles.length)) continue;           // flag says ready but the file is gone: fail closed
      const narratives = nreports.filter((n) => n.order_item_id === item.order_item_id).flatMap((n) => {
        const version = nversions.find((v) => v.narrative_report_id === n.id && v.version_no === n.signed_version_no && v.signed_by_membership_id);
        return version ? [{ report: n, version }] : [];
      });
      if (item.requires_narrative && narratives.length === 0) continue;
      ready.push({ item, file: itemFiles[0], narratives, entry: {
        orderItemId: item.order_item_id, narrativeVersionIds: item.requires_narrative ? narratives.map((n) => n.version.id) : [],
        ...(item.requires_lab ? { approvedSetHash: report.lab_approved_set_hash ?? '' } : {}), ...(item.requires_outsourced ? { inputFileId: itemFiles[0]?.id } : {}) } });
    }
    if (ready.length === 0) { await clear(); done('assemble_report_noop', { reason: 'nothing_ready' }); return; }
    const complete = ready.length === items.length;

    // 3. fingerprint vs the latest NON-discarded version
    const fp = fingerprint({ items: ready.map((r) => r.entry), regenerationCounter: report.regeneration_counter ?? 0 });
    const versions = await rows(`SELECT id, version_no, status, content_fingerprint, released_at FROM reporting.report_versions
      WHERE tenant_id = $1 AND report_id = $2 ORDER BY version_no DESC`, [tenantId, reportId]);
    const latest = versions.find((v) => v.status !== 'discarded');
    const same = fp === latest?.content_fingerprint;
    const settings = same ? undefined : await ctx.ports.identity.getTenantSettings(ctx, { keys: ['partialReleaseAllowed', 'featureFlags'] });
    if (!settings || !shouldAssemble({ fingerprint: fp, ...(latest ? { latestFingerprint: latest.content_fingerprint } : {}), complete, partialReleaseAllowed: settings.partialReleaseAllowed === true })) {
      await clear(); done('assemble_report_noop', { reason: same ? 'same_fingerprint' : 'partial_not_allowed' }); return;
    }

    // 4. template, tenant report settings, centre
    const tpl = (await rows(`SELECT current_version_id FROM reporting.report_templates WHERE tenant_id = $1 AND family = $2 AND is_default = true`, [tenantId, report.family]))[0];
    const tv = tpl ? (await rows(`SELECT id, config FROM reporting.report_template_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, tpl.current_version_id]))[0] : undefined;
    if (!tv) throw new LimsError('common.internal', 'no default report template version');
    const printCriticalLabel = (await rows(`SELECT print_critical_label FROM reporting.settings WHERE tenant_id = $1`, [tenantId]))[0]?.print_critical_label === true;
    const origin = String(process.env['LIMS_ORIGIN_PORTAL'] ?? '').replace(/\/+$/, '');
    if (!origin) throw new LimsError('common.internal', 'LIMS_ORIGIN_PORTAL is not configured');
    const c = await ctx.core.centre(ctx, { centreId: report.centre_id });
    const versionNo = Math.max(report.latest_version_no ?? 0, versions[0]?.version_no ?? 0) + 1;
    const releasedBefore = versions.filter((v) => v.released_at != null || v.status === 'released' || v.status === 'superseded');
    const earlierReleased = releasedBefore.length > 0;
    // R9 (C6-T41): the handler passes the reason in the job payload; a malformed value is ignored (the counter already forced this assembly).
    const rg = payload?.['regeneration'] as Row | undefined;
    const regen = rg && typeof rg === 'object' && typeof rg['reason_code'] === 'string' && rg['reason_code'].length >= 1 && rg['reason_code'].length <= 64
      && (rg['reason_text'] === undefined || rg['reason_text'] === null || (typeof rg['reason_text'] === 'string' && rg['reason_text'].length <= 500))
      ? { reasonCode: rg['reason_code'] as string, ...(typeof rg['reason_text'] === 'string' ? { reasonText: rg['reason_text'] } : {}) } : undefined;
    const { token, tokenSha256 } = issueToken('qr');

    // 5. document from the ports (T06). The LabPort output is captured so attachments are taken from the very same read (P-13).
    let orderResults: any;
    const wrapped = { ...ctx, ports: { ...ctx.ports, lab: { getOrderResults: async (_c: unknown, i: any) => (orderResults = await ctx.ports.lab.getOrderResults(ctx, i)) } } };
    const doc: Row = { ...(await assembleDocument(wrapped as any, {
      orderId: report.order_id, includeOrderItemIds: ready.filter((r) => r.item.requires_lab).map((r) => r.item.order_item_id),
      config: signatoryConfig(tv.config), centre: { code: c.centreCode, name: c.name, ...(c.addressText ? { addressText: c.addressText } : {}) },
      qrVerifyUrl: `${origin}/v/${token}`, reportedAt: now, complete, earlierReleased, printCriticalLabel,
      ...(regen ? { regeneration: { ...regen, previousVersionNo: Math.max(0, ...releasedBefore.map((v) => v.version_no)), amendedAt: now } } : {}),
      // micro / anatomic: read-only single-table SELECT on the published view, by (tenant_id, entity_id, version_no) of the moduleRef (TRD §4.3, CR-C6-006)
      async loadModuleContent(refs) {
        const out: Record<string, Row> = {};
        for (const ref of refs) {
          const view = VIEWS[ref.module];
          const row: Row | undefined = (await rows(`SELECT ${view.columns} FROM ${view.name} WHERE tenant_id = $1 AND entity_id = $2 AND version_no = $3`, [tenantId, ref.entityId, ref.versionNo]))[0];
          if (!row || row['tenant_id'] !== tenantId) throw new LimsError('common.internal', `${view.name} has no row for the moduleRef`);   // never a silently shorter report
          out[moduleKey(ref)] = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, (view.jsonb as readonly string[]).includes(k) ? json(v) : v]));
        }
        return out;
      } })) };

    // 5a. narrative sections (signed versions only)
    const catalog = ctx.ports.catalog;
    const sections: Section[] = [...doc['sections']];
    const signerIds = [...new Set(ready.flatMap((r) => r.narratives.map((n) => n.version.signed_by_membership_id as string)))];
    const signers: Row[] = signerIds.length ? [...(await ctx.ports.identity.getSignatories(ctx, { membershipIds: signerIds }))] : [];
    for (const r of ready) for (const n of r.narratives) {
      const s = signers.find((x) => x.membershipId === n.version.signed_by_membership_id);
      if (!s) throw new LimsError('common.internal', 'narrative signatory unknown to IdentityPort');
      const signedBy: Signatory = { membershipId: s.membershipId, displayName: s.displayName, ...(s.displayTitle ? { displayTitle: s.displayTitle } : {}),
        ...(s.registrationNo ? { registrationNo: s.registrationNo } : {}),
        ...(s.signatureAssetId && s.signatureSha256 ? { signatureAssetRef: { source: 'signature' as const, id: s.signatureAssetId, sha256: s.signatureSha256 } } : {}), role: 'narrative_signer' };
      // ponytail: narrative images are not attached yet (needs input_files lookup by image_file_ids); add with the narrative render path.
      sections.push({ kind: 'narrative', narrativeVersionId: n.version.id, testName: (await catalog.getTest(ctx, { testId: n.report.test_id })).name,
        templateKind: n.report.template_kind, sections: json(n.version.sections) ?? [], images: [], signedBy });
    }

    // 5b. outsourced files (confirmed + sanitised at intake): the snapshot records the sanitised hash
    const outsourcedAttachments: Row[] = []; const outsourcedIndex: { testName: string; externalLabName: string }[] = [];
    for (const r of ready.filter((x) => x.file)) {
      const testName = (await catalog.getTest(ctx, { testId: r.item.test_ids[0] })).name;
      outsourcedAttachments.push({ inputFileId: r.file!.id, externalLabName: r.file!.external_lab_name, testName, pageCount: r.file!.page_count, sha256: r.file!.sanitized_sha256 });
      outsourcedIndex.push({ testName, externalLabName: r.file!.external_lab_name });
    }
    if (outsourcedIndex.length) sections.push({ kind: 'outsourced_index', items: outsourcedIndex });

    // 5c. instrument PDFs: read the (bucket, path) pairs of the port output, sanitise, store content-addressed. Rejected -> omitted + metric; transport error -> throw.
    const analyteNames = new Map<string, string>();
    for (const s of doc['sections'] as Section[]) if (s.kind === 'department') for (const b of s.blocks) for (const g of b.subgroups) for (const l of g.lines) analyteNames.set(l.analyteId, l.name);
    const include = new Set(ready.filter((r) => r.item.requires_lab).map((r) => r.item.order_item_id));
    const instrumentPdfAttachments: Row[] = []; const cache = new Map<string, Row | null>();
    for (const g of (orderResults?.items ?? []).filter((x: Row) => include.has(x.orderItemId))) for (const r of g.results.filter((x: Row) => x.status === 'approved')) for (const a of r.attachments ?? []) {
      if (a.mimeType !== 'application/pdf') continue;
      const key = `${a.bucket}::${a.objectPath}`;
      if (!cache.has(key)) cache.set(key, await sanitizeAttachment(a));
      const ok = cache.get(key);
      if (ok) instrumentPdfAttachments.push({ analyteName: analyteNames.get(r.analyteId) ?? '', objectRef: { source: 'instrument_attachment', id: ok['sanitizedSha256'], sha256: ok['sanitizedSha256'], mimeType: 'application/pdf' },
        sha256: a.sha256, sanitizedSha256: ok['sanitizedSha256'] });
    }
    async function sanitizeAttachment(a: Row): Promise<Row | null> {
      const original: Uint8Array = await ctx.storage.read(a.bucket, a.objectPath);
      const reject = (reason: string) => { ctx.metrics?.inc?.(METRIC, { reason }); ctx.log?.warn?.({ event: 'instrument_pdf_omitted', report_id: reportId, reason }); return null; };
      if (sha(original) !== String(a.sha256).toLowerCase()) return reject('hash_mismatch');
      const out = checkReply(await o.sandbox.sanitize(original));                // transport error throws
      if ('reason' in out) return reject(out.reason);
      const path = `${tenantId}/instrument-pdfs/${out.sha256}.pdf`;
      try { await ctx.storage.put(BUCKET, path, out.bytes, { contentType: 'application/pdf', ifAbsent: true }); }
      catch (e) { const have = await ctx.storage.read(BUCKET, path).catch(() => undefined); if (!have || sha(have) !== out.sha256) throw e; }   // write-once, content-addressed
      return { sanitizedSha256: out.sha256 };
    }

    // 5d. smart section (flag off -> port untouched). Approved only; smartreport.* errors omit the section (savepoint rolls back the port's writes).
    let smart: Row | undefined;
    if (settings.featureFlags?.smart_report === true) {
      await tx.query('SAVEPOINT smart_summary');                                 // TRD §4.3 P-44: worker ctx.db.tx is no savepoint
      try {
        const s = await ctx.ports.smartreport.buildSummary(ctx, { orderId: report.order_id, version: versionNo });
        await tx.query('RELEASE SAVEPOINT smart_summary');
        if (s?.status === 'approved') smart = s;
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT smart_summary');
        if (!String((e as Row)?.code ?? '').startsWith('smartreport.')) throw e;
        ctx.log?.warn?.({ event: 'smart_section_omitted', report_id: reportId, error_code: (e as Row).code });
      }
    }

    const snapshot = { ...doc, sections, outsourcedAttachments, instrumentPdfAttachments, ...(smart ? { smart: { summaryId: smart['summaryId'], templateLibraryVersion: smart['templateLibraryVersion'], payload: smart } } : {}) };
    const snapshotJson = JSON.stringify(snapshot);
    const portal = await ctx.ports.frontdesk.getPatientDemographics(ctx, { patientId: report.patient_id, purpose: 'portal_display' });

    // 6. writes (one transaction, row lock held)
    const versionId = uuidv7();
    await tx.query(`UPDATE reporting.report_versions SET status = 'discarded', discard_reason = 'superseded_unreleased', discarded_at = now(), version = version + 1, updated_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND report_id = $2 AND status IN ('rendering', 'rendered', 'render_failed')`, [tenantId, reportId, actor]);
    const insert = (table: string, cols: [string, unknown, string?][]) => tx.query(
      `INSERT INTO ${table} (${cols.map((x) => x[0]).join(', ')}) VALUES (${cols.map((x, i) => `$${i + 1}${x[2] ? `::${x[2]}` : ''}`).join(', ')})`, cols.map((x) => x[1]));
    await insert('reporting.report_versions', [
      ['id', versionId], ['tenant_id', tenantId], ['centre_id', report.centre_id], ['report_id', reportId], ['order_id', report.order_id], ['patient_id', report.patient_id],
      ['partner_id', report.partner_id ?? null], ['version_no', versionNo], ['status', 'rendering'], ['report_kind', doc['reportKind']], ['completeness', complete ? 'complete' : 'partial'],
      ['order_item_ids', ready.map((r) => r.item.order_item_id), 'uuid[]'], ['content_fingerprint', fp],
      ['approved_set_hash', ready.some((r) => r.item.requires_lab) ? report.lab_approved_set_hash ?? null : null], ['content_snapshot', snapshotJson, 'jsonb'], ['content_sha256', sha(snapshotJson)],
      ['template_version_id', tv.id], ['reported_at', now], ['smart_summary_json', smart ? JSON.stringify(smart) : null, 'jsonb'], ['smart_summary_id', smart?.['summaryId'] ?? null],
      ['smart_summary_version', smart?.['templateLibraryVersion'] ?? null], ['regeneration_reason_code', regen?.reasonCode ?? null], ['regeneration_reason_text', regen?.reasonText ?? null], ['created_by', actor], ['updated_by', actor]]);
    const panels = [...new Set(sections.flatMap((s) => (s.kind === 'department' ? s.blocks.map((b) => b.panelName) : [])))].slice(0, 20);
    await insert('reporting.qr_tokens', [
      ['id', uuidv7()], ['tenant_id', tenantId], ['centre_id', report.centre_id], ['report_id', reportId], ['report_version_id', versionId], ['token_sha256', Buffer.from(hashToken(token))],
      ['lab_name_snapshot', String(doc['lab'].displayName ?? doc['lab'].legalName ?? '').slice(0, 160)], ['patient_display_snapshot', String(portal.fullName).slice(0, 60)],
      ['panel_names_snapshot', panels, 'text[]'], ['issued_at', now], ['created_by', actor], ['updated_by', actor]]);
    await tx.query(`UPDATE reporting.reports SET latest_version_no = $3, needs_assembly = false, needs_assembly_since = NULL, patient_display_name = $4, referrer_name = $5,
        version = version + 1, updated_by = $6, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, reportId, versionNo, doc['header'].patientName, report.referrer_id ? doc['header'].referredBy : null, actor]);
    await tx.query(ENQUEUE_SQL, ['reporting.render_report_version', JSON.stringify({ tenant_id: tenantId, report_id: reportId, report_version_id: versionId }), `render:${versionId}`, null, 5]);
    ctx.metrics?.inc?.('lims_reporting_versions_total', { report_kind: doc['reportKind'], family: report.family });   // T33
    done('report_version_assembled', { version_no: versionNo, report_kind: doc['reportKind'] });
  };
}

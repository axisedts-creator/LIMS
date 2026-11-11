// reporting worker manifest (02-TRD §3.3, §9). Tasks and per_tenant crons land with their tasks.
import type { TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { handle as balanceChanged } from './consumers/billing.balance.changed.v1.js';
import { handle as catalogChanged } from './consumers/catalog.changed.v1.js';
import { handle as orderCancelled } from './consumers/frontdesk.order.cancelled.v1.js';
import { handle as orderCreated } from './consumers/frontdesk.order.created.v1.js';
import { handle as itemsChanged } from './consumers/frontdesk.order.items_changed.v1.js';
import { handle as criticalValue } from './consumers/lab.critical_value.detected.v1.js';
import { handle as readyForReport } from './consumers/lab.order.ready_for_report.v1.js';
import { handle as resultAmended } from './consumers/lab.result.amended.v1.js';
import { handle as resultApproved } from './consumers/lab.result.approved.v1.js';
import { handle as specimenStatus } from './consumers/lab.specimen.status_changed.v1.js';
import { crontab, EXPIRE_PAYMENTS, expirePortalPaymentRequests, PURGE_EPHEMERAL, SWEEP_ASSEMBLY, SWEEP_HELD, SWEEP_RENDERS, sweepAssembly, sweepHeldReleases, sweepStuckRenders } from './cron.js';
import { createPortalPaymentIntent } from './tasks/create_portal_payment_intent.js';
import { refreshPortalPaymentRequest } from './tasks/refresh_portal_payment_request.js';
import { createAssembleReport } from './tasks/assemble_report.js';
import { applyProviderEvents } from './tasks/apply_provider_events.js';
import { checkWhatsappFallback } from './tasks/check_whatsapp_fallback.js';
import { dispatchReleaseDeliveries } from './tasks/dispatch_release_deliveries.js';
import { createProcessInputFile } from './tasks/process_input_file.js';
import { releaseIfEligible } from './tasks/release_if_eligible.js';
import { createBuildBulkPrint } from './tasks/build_bulk_print.js';
import { purgeEphemeral } from './tasks/purge_ephemeral.js';
import { createRenderPrint } from './tasks/render_print.js';
import { createRenderReportVersion } from './tasks/render_report_version.js';
import { createSendDelivery } from './tasks/send_delivery.js';
import { createSendPortalOtp } from './tasks/send_portal_otp.js';

/** [CONV] the /internal/sanitize client is C6-T12; until it is wired every sanitise attempt throws (queue retry, file never ready). */
const unwiredSandbox = { sanitize: async (): Promise<never> => { throw new Error('pdf_sandbox_not_configured'); } };

/** [CONV] the renderer client (api renderer-client/render.client.ts) and the /internal/assemble client (C6-T12) are not wired to env yet (the renderer URL env name is not in
 *  the spec; open point in C6-T09-impl.md): every render attempt fails retryable -> render_failed after 5, never a silent success. */
const unwiredRenderer = { render: async (): Promise<never> => { throw Object.assign(new Error('renderer_not_configured'), { code: 'reporting.render_unavailable' }); } };
const unwiredAssembler = { assemble: async (): Promise<never> => { throw Object.assign(new Error('pdf_sandbox_not_configured'), { code: 'reporting.render_unavailable' }); } };

/** [CONV] C6-T20 registers the name P5 enqueues (app.enqueue_job rejects unregistered tasks); the body (new link + delivery, 02-TRD §9) is not part of T20 and is a logged no-op until its task. */
const reissuePortalLinkStub: TaskHandler = async (payload, ctx) => {
  (ctx as any).log?.info?.({ event: 'reissue_portal_link_stub', link_id: payload?.['link_id'] });
};

export const manifest: WorkerManifest = Object.freeze({
  module: 'reporting',
  tasks: Object.freeze({
    'reporting.process_input_file': createProcessInputFile({ sandbox: unwiredSandbox }),
    'reporting.assemble_report': createAssembleReport({ sandbox: unwiredSandbox }),
    'reporting.render_report_version': createRenderReportVersion({ renderer: unwiredRenderer, sandbox: unwiredAssembler }),
    'reporting.render_print': createRenderPrint({ renderer: unwiredRenderer, sandbox: unwiredAssembler }),       // C6-T16
    'reporting.build_bulk_print': createBuildBulkPrint({ sandbox: unwiredAssembler }),
    [PURGE_EPHEMERAL]: purgeEphemeral,
    'reporting.release_if_eligible': releaseIfEligible,
    'reporting.dispatch_release_deliveries': dispatchReleaseDeliveries,
    'reporting.send_delivery': createSendDelivery(),
    'reporting.check_whatsapp_fallback': checkWhatsappFallback,
    'reporting.send_portal_otp': createSendPortalOtp(),
    'reporting.reissue_portal_link': reissuePortalLinkStub,
    'reporting.apply_provider_events': applyProviderEvents,
    'reporting.create_portal_payment_intent': createPortalPaymentIntent,
    'reporting.refresh_portal_payment_request': refreshPortalPaymentRequest,
    [EXPIRE_PAYMENTS]: expirePortalPaymentRequests,
    [SWEEP_HELD]: sweepHeldReleases,
    [SWEEP_ASSEMBLY]: sweepAssembly,
    [SWEEP_RENDERS]: sweepStuckRenders,
  }),
  maxAttempts: Object.freeze({ 'reporting.process_input_file': 5, 'reporting.assemble_report': 10, 'reporting.render_report_version': 5, 'reporting.render_print': 5, 'reporting.build_bulk_print': 5, [PURGE_EPHEMERAL]: 5, 'reporting.release_if_eligible': 10, 'reporting.dispatch_release_deliveries': 10, 'reporting.send_delivery': 8, 'reporting.check_whatsapp_fallback': 8, 'reporting.send_portal_otp': 8, 'reporting.reissue_portal_link': 8, 'reporting.apply_provider_events': 10, 'reporting.create_portal_payment_intent': 3, 'reporting.refresh_portal_payment_request': 3, [EXPIRE_PAYMENTS]: 5, [SWEEP_ASSEMBLY]: 5, [SWEEP_RENDERS]: 5, [SWEEP_HELD]: 5 }),
  subscriptions: Object.freeze({
    'frontdesk.order.created.v1': orderCreated,
    'frontdesk.order.items_changed.v1': itemsChanged,
    'frontdesk.order.cancelled.v1': orderCancelled,
    'lab.specimen.status_changed.v1': specimenStatus,
    'lab.result.approved.v1': resultApproved,
    'lab.result.amended.v1': resultAmended,
    'lab.order.ready_for_report.v1': readyForReport,
    'lab.critical_value.detected.v1': criticalValue,
    'catalog.changed.v1': catalogChanged,
    'billing.balance.changed.v1': balanceChanged,
  }),
  crontab,
});

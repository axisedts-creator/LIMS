// POST /platform/tenants (02-TRD §5.10; AC-E1.1). x-idempotency required (core platform store, D-213). 201 + ETag.
// Only the TenantProvisionRequest fields (+ LD-26 training_mode, LD-29 contract_acceptance) are forwarded, nested objects included.
import { obj } from './role.http.js';
import { bindTenant, pick } from './tenant.http.js';

const ACC = { version: 'version', accepted_by_name: 'acceptedByName', accepted_by_title: 'acceptedByTitle', accepted_at: 'acceptedAt' };
const OU = { code: 'code', name: 'name', kind: 'kind', address_text: 'addressText' };
const nested = (v: unknown, map: Record<string, string>) => (v === undefined ? undefined : pick(v, map));

export const provisionTenant = bindTenant((s, ctx, req) => {
  const b = obj(req.body);
  const ca = b['contract_acceptance'] === undefined ? undefined : obj(b['contract_acceptance']);
  return s.provisionTenant(ctx, {
    ...pick(b, { code: 'code', legal_name: 'legalName', display_name: 'displayName', pan: 'pan', timezone: 'timezone', calendar_display: 'calendarDisplay', training_mode: 'trainingMode' }),
    firstBranch: nested(b['first_branch'], { code: 'code', name: 'name', address_text: 'addressText' }),
    firstCentre: nested(b['first_centre'], OU),
    firstAdmin: nested(b['first_admin'], { email: 'email', display_name: 'displayName' }),
    contractAcceptance: ca && { tos: nested(ca['tos'], ACC), dpa: nested(ca['dpa'], ACC) },
  });
}, { etag: true });

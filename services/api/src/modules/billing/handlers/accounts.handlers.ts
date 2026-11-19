// T0B-ACCT-1 (LD-313, LD-310) lab accounting handlers: listAccountGroups, createAccountGroup, updateAccountGroup, listAccountParticulars, createAccountParticular,
// updateAccountParticular, createAccountLedgerEntry, listAccountLedgerEntries, getAccountLedgerEntry, reverseAccountLedgerEntry, getAccountStatement, getAccountSummary.
// Schema, auth, x-permission (billing.account.read / billing.account.manage [privileged] / billing.account_entry.create / billing.account_entry.reverse [privileged])
// and Idempotency-Key replay are enforced by the core pipeline from contracts/openapi/billing.yaml; these map request -> service and fail closed without an
// authenticated request context (bind). The service re-validates every value, so a handler called directly never writes an invalid row.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { createAccountsService, type AccountsService } from '../service/accounts.service.js';
import { bind, obj } from './ledger.handlers.js';
import { ifMatch } from './settings.handlers.js';

let svc: AccountsService | undefined;
const service = (): AccountsService => (svc ??= createAccountsService());
const etag = (b: { version: number }) => ({ etag: `"${b.version}"` });
/** x-idempotency required: the pipeline replays; a direct call without the key is refused the same way. */
const needKey = (req: HandlerRequest) => {
  const k = obj(req.headers)['idempotency-key'];
  if (typeof k !== 'string' || k === '') throw new LimsError('common.idempotency_key_required');
};

export const accountsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listAccountGroups: bind(async (ctx, req) => ({ status: 200, body: await service().listGroups(ctx, req.query) })),
  createAccountGroup: bind(async (ctx, req) => {
    needKey(req);
    const b = await service().createGroup(ctx, req.body);
    return { status: 201, body: b, headers: etag(b) };
  }),
  updateAccountGroup: bind(async (ctx, req) => {
    const b = await service().updateGroup(ctx, { id: obj(req.params)['account_group_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: b, headers: etag(b) };
  }),
  listAccountParticulars: bind(async (ctx, req) => ({ status: 200, body: await service().listParticulars(ctx, req.query) })),
  createAccountParticular: bind(async (ctx, req) => {
    needKey(req);
    const b = await service().createParticular(ctx, req.body);
    return { status: 201, body: b, headers: etag(b) };
  }),
  updateAccountParticular: bind(async (ctx, req) => {
    const b = await service().updateParticular(ctx, { id: obj(req.params)['account_particular_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: b, headers: etag(b) };
  }),
  createAccountLedgerEntry: bind(async (ctx, req) => {
    needKey(req);
    return { status: 201, body: await service().createEntry(ctx, req.body) };
  }),
  listAccountLedgerEntries: bind(async (ctx, req) => ({ status: 200, body: await service().listEntries(ctx, req.query) })),
  getAccountLedgerEntry: bind(async (ctx, req) => ({ status: 200, body: await service().getEntry(ctx, obj(req.params)['account_ledger_entry_id']) })),
  reverseAccountLedgerEntry: bind(async (ctx, req) => {
    needKey(req);
    return { status: 201, body: await service().reverseEntry(ctx, { id: obj(req.params)['account_ledger_entry_id'], body: req.body }) };
  }),
  // T0B-FINCTRL-1 (LD-321): billing.account.manage, Idempotency-Key required (pipeline); the service checks the state.
  holdLedgerEntry: bind(async (ctx, req) => {
    needKey(req);
    return { status: 200, body: await service().holdEntry(ctx, { id: obj(req.params)['account_ledger_entry_id'], body: req.body }) };
  }),
  releaseLedgerEntry: bind(async (ctx, req) => {
    needKey(req);
    return { status: 200, body: await service().releaseEntry(ctx, { id: obj(req.params)['account_ledger_entry_id'], body: req.body }) };
  }),
  getAccountStatement: bind(async (ctx, req) => ({ status: 200, body: await service().statement(ctx, req.query) })),
  getAccountSummary: bind(async (ctx, req) => ({ status: 200, body: await service().summary(ctx, req.query) })),
});

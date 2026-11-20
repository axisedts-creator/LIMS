// T0B-ACCT-2 (LD-313, LD-310) lab accounting part 2 handlers: listExpenseTypes, createExpenseType, updateExpenseType, createExpense, listExpenses, cancelExpense,
// createCashTransfer, listCashTransfers, acceptCashTransfer, rejectCashTransfer, cancelCashTransfer, getDailyCollectionSummary.
// Schema, auth, x-permission (billing.account.read / billing.account.manage / billing.expense.manage / billing.cash_transfer.manage / billing.cash_transfer.decide)
// and Idempotency-Key replay come from the core pipeline (contracts/openapi/billing.yaml); these fail closed without a request context (bind) and the service
// re-validates every value. LD-325 (b): these ids were removed from billing pendingOperations.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { guarded } from './_guard.js';
import { createExpensesService, type ExpensesService } from '../service/expenses.service.js';
import { bind, obj } from './ledger.handlers.js';
import { ifMatch } from './settings.handlers.js';

let svc: ExpensesService | undefined;
const service = (): ExpensesService => (svc ??= createExpensesService());
const etag = (b: { version: number }) => ({ etag: `"${b.version}"` });
const needKey = (req: HandlerRequest) => {
  const k = obj(req.headers)['idempotency-key'];
  if (typeof k !== 'string' || k === '') throw new LimsError('common.idempotency_key_required');
};
const p = (req: HandlerRequest, k: string): unknown => obj(req.params)[k];

const expensesHandlersRaw: Readonly<Record<string, Handler>> = Object.freeze({
  listExpenseTypes: bind(async (ctx, req) => ({ status: 200, body: await service().listTypes(ctx, req.query) })),
  createExpenseType: bind(async (ctx, req) => {
    needKey(req);
    const b = await service().createType(ctx, req.body);
    return { status: 201, body: b, headers: etag(b) };
  }),
  updateExpenseType: bind(async (ctx, req) => {
    const b = await service().updateType(ctx, { id: p(req, 'expense_type_id'), expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: b, headers: etag(b) };
  }),
  createExpense: bind(async (ctx, req) => {
    needKey(req);
    return { status: 201, body: await service().createExpense(ctx, req.body) };
  }),
  listExpenses: bind(async (ctx, req) => ({ status: 200, body: await service().listExpenses(ctx, req.query) })),
  cancelExpense: bind(async (ctx, req) => {
    needKey(req);
    return { status: 200, body: await service().cancelExpense(ctx, { id: p(req, 'expense_id'), body: req.body }) };
  }),
  createCashTransfer: bind(async (ctx, req) => {
    needKey(req);
    return { status: 201, body: await service().createTransfer(ctx, req.body) };
  }),
  listCashTransfers: bind(async (ctx, req) => ({ status: 200, body: await service().listTransfers(ctx, req.query) })),
  acceptCashTransfer: bind(async (ctx, req) => {
    needKey(req);
    return { status: 200, body: await service().acceptTransfer(ctx, p(req, 'cash_transfer_id')) };
  }),
  rejectCashTransfer: bind(async (ctx, req) => {
    needKey(req);
    return { status: 200, body: await service().rejectTransfer(ctx, p(req, 'cash_transfer_id')) };
  }),
  cancelCashTransfer: bind(async (ctx, req) => {
    needKey(req);
    return { status: 200, body: await service().cancelTransfer(ctx, p(req, 'cash_transfer_id')) };
  }),
  getDailyCollectionSummary: bind(async (ctx, req) => ({ status: 200, body: await service().dailySummary(ctx, req.query) })),
});

// SEC-AUTHZ-6 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1): the contract x-permission is asked FIRST, before the wrapped handler reads or writes anything.
export const expensesHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  ...expensesHandlersRaw,
  listExpenseTypes: guarded('billing.account.read', expensesHandlersRaw['listExpenseTypes']!),
  createExpenseType: guarded('billing.account.manage', expensesHandlersRaw['createExpenseType']!),
  updateExpenseType: guarded('billing.account.manage', expensesHandlersRaw['updateExpenseType']!),
  createExpense: guarded('billing.expense.manage', expensesHandlersRaw['createExpense']!),
  listExpenses: guarded('billing.account.read', expensesHandlersRaw['listExpenses']!),
  cancelExpense: guarded('billing.expense.manage', expensesHandlersRaw['cancelExpense']!),
  createCashTransfer: guarded('billing.cash_transfer.manage', expensesHandlersRaw['createCashTransfer']!),
  listCashTransfers: guarded('billing.account.read', expensesHandlersRaw['listCashTransfers']!),
  acceptCashTransfer: guarded('billing.cash_transfer.decide', expensesHandlersRaw['acceptCashTransfer']!),
  rejectCashTransfer: guarded('billing.cash_transfer.decide', expensesHandlersRaw['rejectCashTransfer']!),
  cancelCashTransfer: guarded('billing.cash_transfer.manage', expensesHandlersRaw['cancelCashTransfer']!),
  getDailyCollectionSummary: guarded('billing.account.read', expensesHandlersRaw['getDailyCollectionSummary']!),
});

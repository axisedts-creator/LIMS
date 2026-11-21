import 'server-only';
// BFF writes for the inventory master-data screens. Creates send Idempotency-Key; rows that exist send If-Match "<version>" (CV §4.2).
// Path ids and keys are checked here because this is the trust boundary between the browser and the API.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { KEY_RE, UUID_RE, type Alert, type Settings, type SettingsUpdate, type Grn, type GrnDraft, type GrnReplace, type Po, type PoCreate, type ReasonAction, type SentChannel, type AdjustmentCreate, type Barcode, type BarcodeCreate, type Binding, type ConsumptionEventCreate, type Container, type ContainerDiscard, type ContainerOpen, type Count, type CountCreate, type CountLine, type CountLinePut, type ExpiryWriteoffCreate, type Fact, type IssueCreate, type ItemSummary, type StockDocument, type Transfer, type TransferCreate, type TransferReceive, type UncountedPolicy, type WastageCreate, type Item, type ItemCreate, type ItemPatch, type Pack, type PackCreate, type Store, type StoreCreate, type StoreItemSetting, type StoreItemSettingPut, type StorePatch, type Supplier, type SupplierCreate, type SupplierItem, type SupplierItemPut, type SupplierPatch, type Rule, type RuleCreate, type RulePreview, type RulePreviewBody, type RuleSupersede } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const uuid = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const base = '/v1/inventory';

function send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, o: { key?: string; version?: number } = {}): Promise<T> {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && !(Number.isInteger(o.version) && o.version > 0)) throw bad();
  return serverFetch<T>(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(o.key ? { 'idempotency-key': o.key } : {}),
      ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export const createItem = (b: ItemCreate, key: string) => send<Item>('POST', `${base}/items`, b, { key });
export const updateItem = (id: string, version: number, p: ItemPatch) => send<Item>('PATCH', `${base}/items/${uuid(id)}`, p, { version });
export const setItemActive = (id: string, version: number, isActive: boolean) => send<Item>('POST', `${base}/items/${uuid(id)}/set-active`, { is_active: isActive }, { version });
export const createPack = (itemId: string, b: PackCreate, key: string) => send<Pack>('POST', `${base}/items/${uuid(itemId)}/packs`, b, { key });
export const addBarcode = (itemId: string, b: BarcodeCreate, key: string) => send<Barcode>('POST', `${base}/items/${uuid(itemId)}/barcodes`, b, { key });
export const deactivateBarcode = (itemId: string, barcodeId: string, version: number) =>
  send<Barcode>('POST', `${base}/items/${uuid(itemId)}/barcodes/${uuid(barcodeId)}/deactivate`, {}, { version });

export const createStore = (b: StoreCreate, key: string) => send<Store>('POST', `${base}/stores`, b, { key });
export const updateStore = (id: string, version: number, p: StorePatch) => send<Store>('PATCH', `${base}/stores/${uuid(id)}`, p, { version });
export const putStoreItemSetting = (storeId: string, itemId: string, version: number | undefined, b: StoreItemSettingPut) =>
  send<StoreItemSetting>('PUT', `${base}/stores/${uuid(storeId)}/item-settings/${uuid(itemId)}`, b, version === undefined ? {} : { version });

export const createSupplier = (b: SupplierCreate, key: string) => send<Supplier>('POST', `${base}/suppliers`, b, { key });
export const updateSupplier = (id: string, version: number, p: SupplierPatch) => send<Supplier>('PATCH', `${base}/suppliers/${uuid(id)}`, p, { version });
export const putSupplierItem = (supplierId: string, itemId: string, packId: string, version: number | undefined, b: SupplierItemPut) =>
  send<SupplierItem>('PUT', `${base}/suppliers/${uuid(supplierId)}/items/${uuid(itemId)}/packs/${uuid(packId)}`, b, version === undefined ? {} : { version });

// ---- T-23 stock operations. Documents (issue, wastage, adjustment, write-off, transfer, count, container open, consumption event) need an Idempotency-Key;
// state changes on an existing row also send If-Match "<version>". PUT /stock-counts/{id}/lines is neither (contract x-idempotency: none).
export const createIssue = (b: IssueCreate, key: string) => send<StockDocument>('POST', `${base}/issues`, b, { key });
export const createWastage = (b: WastageCreate, key: string) => send<StockDocument>('POST', `${base}/wastage`, b, { key });
export const createAdjustment = (b: AdjustmentCreate, key: string) => send<StockDocument>('POST', `${base}/adjustments`, b, { key });
export const createExpiryWriteoff = (b: ExpiryWriteoffCreate, key: string) => send<StockDocument>('POST', `${base}/expiry-writeoffs`, b, { key });

export const createTransfer = (b: TransferCreate, key: string) => send<Transfer>('POST', `${base}/transfers`, b, { key });
export const dispatchTransfer = (id: string, version: number, key: string) => send<Transfer>('POST', `${base}/transfers/${uuid(id)}/dispatch`, {}, { key, version });
export const receiveTransfer = (id: string, version: number, key: string, b: TransferReceive) => send<Transfer>('POST', `${base}/transfers/${uuid(id)}/receive`, b, { key, version });
export const cancelTransfer = (id: string, version: number, key: string) => send<Transfer>('POST', `${base}/transfers/${uuid(id)}/cancel`, {}, { key, version });

export const createCount = (b: CountCreate, key: string) => send<Count>('POST', `${base}/stock-counts`, b, { key });
export const putCountLines = (id: string, lines: CountLinePut[]) => send<{ updated: number; lines: CountLine[] }>('PUT', `${base}/stock-counts/${uuid(id)}/lines`, { lines }, {});
export const postCount = (id: string, version: number, key: string, uncountedPolicy: UncountedPolicy) =>
  send<Count>('POST', `${base}/stock-counts/${uuid(id)}/post`, { uncounted_policy: uncountedPolicy }, { key, version });

/** Read-only POST: the scanned barcode goes in the body only, never a URL (REQ-SEC-098). */
export const lookupBarcode = (value: string) => send<{ item: ItemSummary }>('POST', `${base}/barcodes/lookup`, { barcode_value: value }, {});

export const openContainer =(b: ContainerOpen, key: string) => send<Container>('POST', `${base}/containers`, b, { key });
export const finishContainer = (id: string, version: number, key: string) => send<Container>('POST', `${base}/containers/${uuid(id)}/finish`, {}, { key, version });
export const discardContainer = (id: string, version: number, key: string, b: ContainerDiscard) =>
  send<{ container: Container; document: StockDocument }>('POST', `${base}/containers/${uuid(id)}/discard`, b, { key, version });
export const logConsumptionEvent = (b: ConsumptionEventCreate, key: string) => send<Fact>('POST', `${base}/consumption-events`, b, { key });

export const putBinding =(instrumentId: string, version: number | undefined, storeId: string) =>
  send<Binding>('PUT', `${base}/instrument-bindings/${uuid(instrumentId)}`, { store_id: uuid(storeId) }, version === undefined ? {} : { version });
export const deactivateBinding = (instrumentId: string, version: number) =>
  send<Binding>('POST', `${base}/instrument-bindings/${uuid(instrumentId)}/deactivate`, {}, { version });

// ---- T-22 purchasing + receiving. Create needs an Idempotency-Key; replace (PUT) sends If-Match; lifecycle transitions send both.
export const createPo = (b: PoCreate, key: string) => send<Po>('POST', `${base}/purchase-orders`, b, { key });
export const replacePo = (id: string, version: number, b: PoCreate) => send<Po>('PUT', `${base}/purchase-orders/${uuid(id)}`, b, { version });
export const approvePo = (id: string, version: number, key: string) => send<Po>('POST', `${base}/purchase-orders/${uuid(id)}/approve`, {}, { key, version });
export const markPoSent = (id: string, version: number, key: string, b: { sent_channel: SentChannel; sent_reference?: string }) => send<Po>('POST', `${base}/purchase-orders/${uuid(id)}/mark-sent`, b, { key, version });
export const cancelPo = (id: string, version: number, key: string, b: ReasonAction) => send<Po>('POST', `${base}/purchase-orders/${uuid(id)}/cancel`, b, { key, version });
export const closePo = (id: string, version: number, key: string, b: ReasonAction) => send<Po>('POST', `${base}/purchase-orders/${uuid(id)}/close`, b, { key, version });

export const createGrn = (b: GrnDraft, key: string) => send<Grn>('POST', `${base}/goods-receipts`, b, { key });
// kind and store_id are fixed once a draft exists; the PUT schema rejects them (additionalProperties: false), so strip them here too.
export const replaceGrn = (id: string, version: number, b: GrnReplace) => {
  const { kind: _k, store_id: _s, ...rest } = b as GrnReplace & Partial<Pick<GrnDraft, 'kind' | 'store_id'>>;
  return send<Grn>('PUT', `${base}/goods-receipts/${uuid(id)}`, rest, { version });
};
export const postGrn = (id: string, version: number, key: string) => send<Grn>('POST', `${base}/goods-receipts/${uuid(id)}/post`, {}, { key, version });

// ---- T-24 consumption rules (#70, #72-#74) and facts (#77, #78). Create / supersede / resolve send an Idempotency-Key; changes to an existing row send If-Match "<version>".
export const createRule = (b: RuleCreate, key: string) => send<Rule>('POST', `${base}/consumption-rules`, b, { key });
export const supersedeRule = (id: string, version: number, key: string, b: RuleSupersede) => send<Rule>('POST', `${base}/consumption-rules/${uuid(id)}/supersede`, b, { key, version });
export const deactivateRule = (id: string, version: number, key: string) => send<Rule>('POST', `${base}/consumption-rules/${uuid(id)}/deactivate`, {}, { key, version });
/** Dry run (read-only POST): nothing is written. */
export const previewRule = (b: RulePreviewBody) => send<RulePreview>('POST', `${base}/consumption-rules/preview`, b, {});
export const resolveFact = (id: string, version: number, key: string, storeId: string) => send<Fact>('POST', `${base}/consumption-facts/${uuid(id)}/resolve`, { store_id: uuid(storeId) }, { key, version });
export const dismissFact = (id: string, version: number, key: string, reasonCode: string) => send<Fact>('POST', `${base}/consumption-facts/${uuid(id)}/dismiss`, { reason_code: reasonCode }, { key, version });
// ---- T-20 shell. Acknowledge is a state change on an existing row (If-Match "<version>"); settings is a full PUT of SettingsUpdate (TRD #26, #27).
export const acknowledgeAlert = (id: string, version: number) => send<Alert>('POST', `${base}/alerts/${uuid(id)}/acknowledge`, {}, { version });
export const putSettings = (version: number, b: SettingsUpdate) => send<Settings>('PUT', `${base}/settings`, b, { version });

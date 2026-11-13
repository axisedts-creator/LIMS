import { canReadCost, pick, type Row } from './_dto.js';

const SUMMARY = ['id', 'supplier_code', 'name', 'is_active', 'version'] as const;
const FULL = [...SUMMARY.slice(0, 3), 'pan_text', 'contact_name', 'phone_display', 'email', 'address_text', 'payment_terms_days', 'notes', 'is_active', 'version', 'updated_at'] as const;
const ITEM = ['id', 'supplier_id', 'item_id', 'pack_id', 'supplier_item_code', 'last_unit_price_paisa', 'lead_time_days', 'default_tax_code', 'is_active', 'version'] as const;

// Contact fields (pan, phone, email, address) exist only on the supplier endpoints (07-SECURITY row 081); the summary never carries them.
export const toSupplierDto = (row: Row, _permissions?: readonly string[]): Row => pick(row, FULL, false);
export const toSupplierSummaryDto = (row: Row, _permissions?: readonly string[]): Row => pick(row, SUMMARY, false);
export const toSupplierItemDto = (row: Row, permissions: readonly string[]): Row => pick(row, ITEM, canReadCost(permissions));

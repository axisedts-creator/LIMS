// BL-T15 review item 4: 02-TRD §5.2 CreditNoteRegisterRow = "one row per credit note, both kinds, ordered by credit_note_seq".
// Concurrent issues can commit seq order != issued_at order, so the SQL itself must order by (fiscal_year_bs, credit_note_seq), never by issued_at.
import { describe, expect, it } from 'vitest';
import { listCreditNoteRegister } from '../registers.repo.js';

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';

describe('registers.repo listCreditNoteRegister ordering (B26)', () => {
  it('ORDER BY is the credit-note sequence (fiscal year, then credit_note_seq); issued_at and id are not ordering keys', async () => {
    const seen: string[] = [];
    const tx = { async query(text: string) { seen.push(text); return { rows: [], rowCount: 0 }; } };
    await listCreditNoteRegister(tx as never, { tenantId: TENANT, limit: 50 });
    expect(seen).toHaveLength(1);
    const order = /ORDER BY\s+([\s\S]*?)\s+LIMIT/i.exec(seen[0])?.[1] ?? '';
    expect(order, seen[0]).toMatch(/credit_note_seq/);
    expect(order).toMatch(/fiscal_year_bs[\s\S]*credit_note_seq/);
    expect(order).not.toMatch(/issued_at/);
  });
});

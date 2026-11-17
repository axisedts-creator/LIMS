// T-25 helper self-check: the starter workbook reads back as expected and survives an edit round trip (no cell lost or invented).
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../../xlsx/XlsxReader.js';
import { addRow, masterXlsx, rowOf, setCell, starterBook, toXlsx } from './kindWorkbooks.js';

describe('kindWorkbooks', () => {
  it('reads the C0 starter: _meta says catalog_master v1; the sheets of 02-TRD §8.2 exist', async () => {
    const b = await starterBook();
    expect(Object.keys(b)).toEqual(expect.arrayContaining(['_meta', 'Departments', 'SpecimenTypes', 'Containers', 'Methods', 'Units', 'ValueSets', 'Tests', 'Analytes', 'ReferenceRanges', 'CriticalLimits', 'Panels', 'PanelMembers', 'CommentCodes', 'TatTargets']));
    expect(b['_meta']!.slice(1, 3)).toEqual([['template_kind', 'catalog_master'], ['template_version', 1]]);
    expect(b['Analytes']!.length - 1).toBe(24);
  });
  it('an edit round trip changes only the edited cell', async () => {
    const b0 = await starterBook();
    const bytes = await masterXlsx((b) => { setCell(b, 'Analytes', 'HB', 'decimals', 2, 1); addRow(b, 'CommentCodes', { code: 'EXTRA', text: 'Synthetic.' }); });
    const b1 = Object.fromEntries((await readXlsx(bytes)).map((s) => [s.name, s.rows]));
    expect(rowOf(b1, 'Analytes', 'HB', 1)[9]).toBe(2);
    expect(b1['CommentCodes']!.at(-1)![0]).toBe('EXTRA');
    expect(b1['Departments']).toEqual(b0['Departments']);
    expect((await readXlsx(await toXlsx(b0))).find((s) => s.name === '_meta')!.rows).toEqual(b0['_meta']);
  });
});

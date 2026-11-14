// DB rows -> OpenAPI DTOs (BreakpointSetDto, BreakpointImportIssueDto, BreakpointRowDto). Optional fields are omitted when NULL, never null.
// The storage bucket / object path / created_by never leave the service (T-B6, S-15).
type Row = Record<string, any>;
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const has = (v: unknown): boolean => v !== null && v !== undefined;

export interface SetNames { readonly importedBy: string; readonly activatedBy?: string | undefined }

export function setDto(row: Row, names: SetNames): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row['id'], version: row['version'], standard: row['standard'], standard_version: row['standard_version'], title: row['title'],
    licence_attestation_text: row['licence_attestation_text'], status: row['status'], file_sha256: row['file_sha256'], file_bytes: row['file_bytes'],
    row_count: row['row_count'], band_count: row['band_count'], error_count: row['error_count'], warning_count: row['warning_count'],
    imported_by_display: names.importedBy, created_at: iso(row['created_at']),
  };
  if (has(row['intended_effective_from'])) out['intended_effective_from'] = iso(row['intended_effective_from']);
  if (has(row['effective_from'])) out['effective_from'] = iso(row['effective_from']);
  if (has(row['effective_to'])) out['effective_to'] = iso(row['effective_to']);
  if (names.activatedBy !== undefined) out['activated_by_display'] = names.activatedBy;
  if (has(row['activated_at'])) out['activated_at'] = iso(row['activated_at']);
  if (has(row['retired_at'])) out['retired_at'] = iso(row['retired_at']);
  return out;
}

export function issueDto(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = { severity: row['severity'], code: row['code'], message: row['message'] };
  if (has(row['line_no'])) out['line_no'] = row['line_no'];
  if (has(row['field'])) out['field'] = row['field'];
  return out;
}

export function rowDto(row: Row, bands: readonly Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row['id'], line_no: row['line_no'], organism_scope: row['organism_scope'], antibiotic_code: row['antibiotic_code'], method: row['method'],
    bands: bands.map((b) => {
      const o: Record<string, unknown> = { id: b['id'], band_no: b['band_no'], category_code: b['category_code'], lower_inclusive: b['lower_inclusive'], upper_inclusive: b['upper_inclusive'] };
      if (has(b['lower_value'])) o['lower_value'] = String(b['lower_value']);
      if (has(b['upper_value'])) o['upper_value'] = String(b['upper_value']);
      if (has(b['note'])) o['note'] = b['note'];
      return o;
    }),
  };
  if (has(row['organism_code'])) out['organism_code'] = row['organism_code'];
  if (has(row['specimen_site_code'])) out['specimen_site_code'] = row['specimen_site_code'];
  if (has(row['qualifier_code'])) out['qualifier_code'] = row['qualifier_code'];
  return out;
}

/** M49 (TRD §9.1): the exact header and the two comment lines, no values. */
export const TEMPLATE_CSV = [
  'organism_scope,organism_code,antibiotic_code,method,specimen_site_code,qualifier_code,category_code,lower_value,lower_inclusive,upper_value,upper_inclusive,note',
  '# One line per interpretive band; see the user manual.',
  '# This file must contain only breakpoint data your laboratory is licensed to use.',
  '',
].join('\n');

// DB rows -> OpenAPI DTOs (MicroCodeDto, MicroSettingsDto, PlatingProtocolDto). Optional fields are omitted when NULL, never null.
import { EXTRAS, type SetName } from '../repository/codedsets.repo.js';

type Row = Record<string, any>;
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

export function codeDto(setName: SetName, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = { code: row['code'], display: row['display'], sort_order: row['sort_order'], is_active: row['is_active'], source: row['source'] };
  if (setName === 'ast_interpretations') out['standard'] = row['standard'];
  else for (const e of EXTRAS[setName]) if (row[e.name] !== null && row[e.name] !== undefined) out[e.name] = row[e.name];
  return out;
}

/** M39 with no row: column defaults of 05-SCHEMA at version 1 (no id / timestamps). */
export const defaultSettingsDto = (): Record<string, unknown> => ({
  version: 1, zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48,
  early_final_requires_reason: true, recent_window_days: 7, is_active: true,
});

export function settingsDto(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row['id'], version: row['version'], zone_suggestion_enabled: row['zone_suggestion_enabled'], mic_suggestion_enabled: row['mic_suggestion_enabled'],
    default_final_no_growth_hours: row['default_final_no_growth_hours'], early_final_requires_reason: row['early_final_requires_reason'],
    recent_window_days: row['recent_window_days'], is_active: row['is_active'], created_at: iso(row['created_at']), updated_at: iso(row['updated_at']),
  };
  if (row['manual_ast_standard'] !== null && row['manual_ast_standard'] !== undefined) out['manual_ast_standard'] = row['manual_ast_standard'];
  return out;
}

export function protocolDto(row: Row, media: readonly Row[], keys: readonly Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row['id'], version: row['version'], code: row['code'], version_no: row['version_no'], display: row['display'],
    read_schedule_hours: row['read_schedule_hours'], final_no_growth_hours: row['final_no_growth_hours'], requires_gram_stain: row['requires_gram_stain'],
    is_active: row['is_active'], created_at: iso(row['created_at']), updated_at: iso(row['updated_at']),
    media: media.map((m) => ({ media_code: m['media_code'], sort_order: m['sort_order'], ...(m['incubation_text'] == null ? {} : { incubation_text: m['incubation_text'] }) })),
    applies_to: keys.map((k) => ({ ...(k['test_id'] == null ? {} : { test_id: k['test_id'] }), ...(k['specimen_type_code'] == null ? {} : { specimen_type_code: k['specimen_type_code'] }) })),
  };
  if (row['default_specimen_site_code'] != null) out['default_specimen_site_code'] = row['default_specimen_site_code'];
  if (row['superseded_at'] != null) out['superseded_at'] = iso(row['superseded_at']);
  return out;
}

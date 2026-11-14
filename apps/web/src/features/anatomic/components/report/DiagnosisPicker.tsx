'use client';
// 04-UI-UX §4.2.7 Diagnosis codes: kit Combobox over K11 coded set `diagnoses` (search sends `q` only), chosen codes as a removable list, at most 20. Only `{code}` is saved;
// the display text comes back from the server. Text, never HTML (REQ-SEC-088). LD-140 (2026-11-13, binding): kit components and token class names only.
import { Combobox } from '@lims/ui/components/Combobox';
import { IconButton } from '@lims/ui/components/IconButton';
import { searchDiagnosesAction } from '../../server/actions.report';
import type { DiagnosisCode, DiagnosisOption } from '../../server/report.types';

export const MAX_CODES = 20;

export function DiagnosisPicker({ codes, readOnly, onChange }: { codes: readonly DiagnosisCode[]; readOnly: boolean; onChange: (next: DiagnosisCode[]) => void }) {
  const load = async (q: string): Promise<readonly DiagnosisOption[]> => {
    const r = await searchDiagnosesAction(q);
    return r.ok ? r.data.filter((o) => !codes.some((c) => c.code === o.code)) : [];
  };
  return (
    <section aria-labelledby="report-codes">
      <h3 id="report-codes" className="lims-card-title">Diagnosis codes</h3>
      {readOnly || codes.length >= MAX_CODES ? null : (
        <Combobox<DiagnosisOption>
          key={codes.length}
          label="Diagnosis codes"
          name="diagnosis_codes"
          description={`Up to ${MAX_CODES} codes.`}
          loadOptions={(q) => load(q)}
          getKey={(o) => o.code}
          renderOption={(o) => `${o.code} — ${o.display}`}
          renderValue={(o) => o.display}
          onChange={(o) => o && onChange([...codes, { code: o.code, display: o.display, system: o.system }])}
        />
      )}
      <ul>
        {codes.map((c) => (
          <li key={c.code}>
            <span>{c.code} — {c.display}</span>
            {readOnly ? null : <IconButton label={`Remove ${c.display}`} icon="close" onPress={() => onChange(codes.filter((x) => x.code !== c.code))} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

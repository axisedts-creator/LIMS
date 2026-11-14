// Plating protocol + AST panel precedence (02-TRD §4.2). Pure; inputs are never mutated.
export interface ProtocolKey { protocol_code: string; test_id: string | null; specimen_type_code: string | null; is_active: boolean }
export interface PanelCandidate {
  id: string; code: string; organism_code: string | null; organism_group_code: string | null;
  specimen_site_code: string | null; is_active: boolean; superseded_at: Date | null;
}

// (test+type) > (test) > (type) > (any, any); ties -> lowest protocol_code. null = no match.
export function selectPlatingProtocol(
  keys: readonly ProtocolKey[],
  req: { test_id: string; specimen_type_code: string },
): string | null {
  let best: { code: string; score: number } | null = null;
  for (const k of keys) {
    if (!k.is_active) continue;
    if (k.test_id !== null && k.test_id !== req.test_id) continue;
    if (k.specimen_type_code !== null && k.specimen_type_code !== req.specimen_type_code) continue;
    const score = (k.test_id !== null ? 2 : 0) + (k.specimen_type_code !== null ? 1 : 0);
    if (!best || score > best.score || (score === best.score && k.protocol_code < best.code)) best = { code: k.protocol_code, score };
  }
  return best?.code ?? null;
}

// (organism,site) > (organism,any) > (group,site) > (group,any) > (any,site) > (any,any); ties -> lowest code, then lowest id.
export function selectAstPanel(
  panels: readonly PanelCandidate[],
  req: { organism_code: string; organism_group_code: string | null; specimen_site_code: string | null },
): { id: string; code: string } | null {
  let best: { p: PanelCandidate; score: number } | null = null;
  for (const p of panels) {
    if (!p.is_active || p.superseded_at !== null) continue;
    if (p.organism_code !== null && p.organism_code !== req.organism_code) continue;
    if (p.organism_group_code !== null && (req.organism_group_code === null || p.organism_group_code !== req.organism_group_code)) continue;
    if (p.specimen_site_code !== null && (req.specimen_site_code === null || p.specimen_site_code !== req.specimen_site_code)) continue;
    const tier = p.organism_code !== null ? 2 : p.organism_group_code !== null ? 1 : 0;
    const score = tier * 2 + (p.specimen_site_code !== null ? 1 : 0);
    if (!best || score > best.score
      || (score === best.score && (p.code < best.p.code || (p.code === best.p.code && p.id < best.p.id)))) best = { p, score };
  }
  return best ? { id: best.p.id, code: best.p.code } : null;
}

// @lims/test-fixtures `tenants` (C0 02-TRD §3.5, CV §11.2). Fixed ids, SYNTHETIC names; never regenerated.
// [CONV] branch/centre ids reuse the tenant id family (IC §1): last 4 hex = <tenant nibble><kind 1=branch 2=centre><nn>.

export type CentreKind = 'own' | 'franchise' | 'home_collection';
export interface FixtureBranch { readonly id: string; readonly name: string }
export interface FixtureCentre { readonly id: string; readonly centre_code: string; readonly name: string; readonly centre_kind: CentreKind }
export interface FixtureTenant {
  readonly id: string;
  readonly name: string;
  readonly branches: readonly FixtureBranch[];
  readonly centres: readonly FixtureCentre[];
}

const ID = (suffix: string): string => `01a1a98a-ac40-7000-8000-00000000${suffix}`;

function tenant(n: 'a' | 'b', name: string, label: string): FixtureTenant {
  return {
    id: ID(`${n}001`),
    name,
    branches: [
      { id: ID(`${n}101`), name: `${label} Main Branch (SYNTHETIC)` },
      { id: ID(`${n}102`), name: `${label} East Branch (SYNTHETIC)` },
    ],
    centres: [
      // centre 1 = scope of the centre-scoped centre_staff actor (actors/index.ts)
      { id: ID(`${n}201`), centre_code: `${n.toUpperCase()}-C1`, name: `${label} Centre 1 (SYNTHETIC)`, centre_kind: 'own' },
      { id: ID(`${n}202`), centre_code: `${n.toUpperCase()}-C2`, name: `${label} Centre 2 (SYNTHETIC)`, centre_kind: 'franchise' },
      { id: ID(`${n}203`), centre_code: `${n.toUpperCase()}-HC`, name: `${label} Home Collection (SYNTHETIC)`, centre_kind: 'home_collection' },
    ],
  };
}

export const tenants: { readonly tenant_a: FixtureTenant; readonly tenant_b: FixtureTenant } = {
  tenant_a: tenant('a', 'Synthetic Lab Alpha', 'Alpha'),
  tenant_b: tenant('b', 'Synthetic Lab Beta', 'Beta'),
};

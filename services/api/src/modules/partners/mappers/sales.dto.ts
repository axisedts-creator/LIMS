// T0B-SALES-1: rows -> contract shapes of partners.yaml (SalesDesignation, SalesRepresentative, SalesTreeNode, PartySalesAssignment, RepresentativeClient,
// ServiceArea). Optional keys are left out when NULL (never null on the wire); tenant_id and the audit columns never leave the service.
type Row = Record<string, any>;
const opt = (k: string, v: unknown): Record<string, unknown> => (v === null || v === undefined ? {} : { [k]: v });

export const toDesignationDto = (r: Row) => ({
  id: r['id'], name: r['name'], level: Number(r['level']), is_active: r['is_active'] === true, version: Number(r['version']), created_at: r['created_at'], updated_at: r['updated_at'],
});

export const toRepresentativeDto = (r: Row) => ({
  id: r['id'], name: r['name'], ...opt('phone', r['phone']), ...opt('email', r['email']), ...opt('user_id', r['user_id']),
  designation_id: r['designation_id'], designation_level: Number(r['designation_level']), ...opt('manager_id', r['manager_id']), ...opt('joining_date', r['joining_date']),
  is_active: r['is_active'] === true, version: Number(r['version']), created_at: r['created_at'], updated_at: r['updated_at'],
});

export const toTreeNodeDto = (r: Row) => ({
  id: r['id'], name: r['name'], designation_id: r['designation_id'], designation_level: Number(r['designation_level']), ...opt('manager_id', r['manager_id']),
  depth: Number(r['depth']), is_active: r['is_active'] === true,
});

export const toAssignmentDto = (r: Row) => ({
  id: r['id'], party_kind: r['party_kind'], party_id: r['party_id'], representative_id: r['representative_id'], effective_from: r['effective_from'],
  ...opt('effective_to', r['effective_to']), version: Number(r['version']), created_at: r['created_at'], updated_at: r['updated_at'],
});

export const toClientDto = (r: Row) => ({
  assignment_id: r['assignment_id'], party_kind: r['party_kind'], party_id: r['party_id'], party_name: r['party_name'], outstanding_paisa: Number(r['outstanding_paisa']),
  ...opt('last_bill_date', r['last_bill_date']), effective_from: r['effective_from'], ...opt('effective_to', r['effective_to']),
});

export const toServiceAreaDto = (r: Row) => ({
  id: r['id'], name: r['name'], district: r['district'], ...opt('area_text', r['area_text']), ...opt('centre_id', r['centre_id']),
  is_active: r['is_active'] === true, version: Number(r['version']), created_at: r['created_at'], updated_at: r['updated_at'],
});

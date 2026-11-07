import { useState } from 'react';
import { PermissionMatrix } from './PermissionMatrix';

export default { title: 'Data/PermissionMatrix', component: PermissionMatrix };

const modules = [{ id: 'lab', label: 'Lab' }, { id: 'admin', label: 'Admin' }];
const permissions = [
  { code: 'lab.result.enter', moduleId: 'lab', resource: 'result' },
  { code: 'lab.result.release', moduleId: 'lab', resource: 'result', isPrivileged: true },
  { code: 'admin.user.manage', moduleId: 'admin', resource: 'user', isPrivileged: true },
  { code: 'admin.tenant.own', moduleId: 'admin', resource: 'tenant', isAssignable: false, unassignableReason: 'Reserved for the platform owner' },
];
export const Default = {
  render: () => {
    const [v, setV] = useState<string[]>(['lab.result.enter']);
    return <PermissionMatrix label="Permissions" modules={modules} permissions={permissions} value={v} onChange={setV} />;
  },
};

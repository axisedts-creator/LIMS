// U1–U6 (partner admin) and SA8–SA10 (staff) — thin handlers over service/partner-user.service.ts (T06).
import type { Handler } from '../../../core/module.js';
import { change, invite, listUsers, resend } from '../service/partner-user.service.js';

export const listPartnerUsers: Handler = (req, ctx) => listUsers(req, ctx, 'partner');
export const invitePartnerUser: Handler = (req, ctx) => invite(req, ctx, 'partner');
export const changePartnerUserRole: Handler = (req, ctx) => change(req, ctx, 'partner', 'set_role');
export const deactivatePartnerUser: Handler = (req, ctx) => change(req, ctx, 'partner', 'deactivate');
export const reactivatePartnerUser: Handler = (req, ctx) => change(req, ctx, 'partner', 'reactivate');
export const resendPartnerInvitation: Handler = (req, ctx) => resend(req, ctx);

export const listPartnerUsersForPartner: Handler = (req, ctx) => listUsers(req, ctx, 'staff');
export const invitePartnerUserByStaff: Handler = (req, ctx) => invite(req, ctx, 'staff');
export const changePartnerUserRoleByStaff: Handler = (req, ctx) => change(req, ctx, 'staff', 'set_role');
export const deactivatePartnerUserByStaff: Handler = (req, ctx) => change(req, ctx, 'staff', 'deactivate');
export const reactivatePartnerUserByStaff: Handler = (req, ctx) => change(req, ctx, 'staff', 'reactivate');

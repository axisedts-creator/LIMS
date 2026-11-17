// Frontdesk permission codes, verbatim from 02-TRD §7 (03-IC §11; settings.manage + patient.anonymise per CR-C4-008).
// The registered-but-unused merge code (merge deferred, PRD §5) is deliberately not listed.
export const FRONTDESK_PERMISSIONS = Object.freeze({
  registrationCreate: 'frontdesk.registration.create',
  patientRead: 'frontdesk.patient.read',
  orderRead: 'frontdesk.order.read',
  orderEdit: 'frontdesk.order.edit',
  orderCancel: 'frontdesk.order.cancel',
  discountApply: 'frontdesk.discount.apply',
  discountApprove: 'frontdesk.discount.approve',
  trfUpload: 'frontdesk.trf.upload',
  settingsManage: 'frontdesk.settings.manage',
  patientAnonymise: 'frontdesk.patient.anonymise',
} as const);

// Shared by manifest.test.ts and settings.handlers.test.ts: operationIds that already have a real handler (not the T01 501 stub).
// Each later task adds its operationIds here (lead-visible tester edit).
export const IMPLEMENTED = new Set([
  'getReportingSettings', 'updateReportingSettings', 'listCentreContacts', 'createCentreContact', 'updateCentreContact',
  'replaceStaffAssignments', 'upsertReferrerPreference', 'listReportingCodes',                                   // C6-T03
  'uploadOutsourcedReport', 'listOutsourcedReports', 'confirmOutsourcedReport', 'withdrawOutsourcedReport', 'downloadOutsourcedReport', 'listOutsourcedItems', // C6-T10
  'uploadNarrativeImage', 'getNarrativeImageContent',                                                          // C6-T11
  'listNarrativeReports', 'getNarrativeReport', 'saveNarrativeDraft', 'signNarrativeReport', 'startNarrativeAmendment', // C6-T17
  'listNarrativeTemplates', 'createNarrativeTemplate', 'updateNarrativeTemplate',
  'listReportTemplates', 'createReportTemplate', 'getReportTemplate', 'updateReportTemplateDraft', 'publishReportTemplate', // C6-T18 (previewReportTemplate stays a stub: C6-T16)
  'retryRenderReportVersion',                                                                                  // C6-T09
  'releaseReportVersion',                                                                                      // C6-T13
  'bulkReleaseReportVersions',                                                                                 // C6-T14
  'listReports', 'searchReports', 'getReport', 'getReportVersion', 'downloadReportVersionPdf',                // C6-T15 (R1-R5)
  'createPortalOtpChallenge', 'verifyPortalOtp', 'getPortalReport', 'downloadPortalReportPdf', 'requestPortalLinkReissue', 'endPortalSession', // C6-T20 (P1-P6)
  'verifyReportQr', 'revokeReportQrToken', 'listPortalLinks', 'revokePortalLink',                            // C6-T22 (verifyHandlers)
]);

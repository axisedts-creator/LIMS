// Synthetic ReportDocument for template previews (AC-13.1; 07-SECURITY "Template previews use synthetic data only").
// No asset refs: a preview needs no stored image. A fresh object on every call, so a preview cannot mutate shared state.
import type { ReportDocument } from './contract.js';

export function previewSampleDocument(): ReportDocument {
  const line = (n: number, name: string, valueText: string, refRangeText: string, unitText: string, extra: object = {}) => ({
    analyteId: `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`, resultId: `018f0000-0000-7000-9000-${String(n).padStart(12, '0')}`,
    versionNo: 1, name, valueText, valueBold: false, refRangeText, unitText, images: [], ...extra,
  });
  return {
    schemaVersion: 1, family: 'laboratory', reportKind: 'final', statusLabel: 'Final',
    lab: { displayName: 'Synthetic Sample Lab', legalName: 'Synthetic Sample Lab Pvt. Ltd.', addressText: 'Sample Road 1, Synthetic City',
      contactStrip: ['lab@synthetic.example', 'Tel: +977-1-0000000', 'www.synthetic.example'] },
    header: {
      patientName: 'Sample Test Patient', ageGender: '43 Years/MALE', regNo: '0001SA000001', barcodeNos: ['S2600000001'],
      sampleCollectedAt: '2026-01-05T02:25:00Z', sampleReceivedAt: '2026-01-05T02:55:00Z', registeredAt: '2026-01-05T02:17:00Z',
      reportedAt: '2026-01-05T04:45:00Z', referredBy: 'SELF',
      collectedAtCentre: { code: 'C000000001', name: 'SYNTHETIC SAMPLE CENTRE', addressText: 'Sample Centre Lane 1' },
    },
    calendarDisplay: 'AD', timezone: 'Asia/Kathmandu',
    sections: [{
      kind: 'department', departmentId: '018f0000-0000-7000-a000-000000000001', departmentName: 'HAEMATOLOGY', approvedBy: ['Dr. Sample Signatory'],
      blocks: [{
        panelName: 'CBC (Sample panel)', specimenLine: 'EDTA WHOLE BLOOD', comments: [],
        subgroups: [{ subheading: 'RBC parameters', lines: [
          line(1, 'Haemoglobin', '17.9', '13.0 - 17.0', 'g/dL', { flagLabel: 'High', valueBold: true, methodLine: 'METHOD : Sample Photometric Method' }),
          line(2, 'RBC count', '4.8', '4.5 - 5.9', 'x10^12/L'),
        ] }],
      }],
    }],
    amendmentNotes: [],
    signatories: [{ membershipId: '018f0000-0000-7000-8000-0000000000f1', displayName: 'Dr. Sample Signatory', displayTitle: 'MD Pathology',
      council: 'NMC', registrationNo: 'NMC-SAMPLE-1', role: 'approver' }],
    disclaimers: ['Sample preview with synthetic data. Not a valid report.'],
    qr: { verifyUrl: 'https://portal.example.invalid/v/SampleTokenSampleToken' },
    outsourcedAttachments: [], instrumentPdfAttachments: [],
  };
}

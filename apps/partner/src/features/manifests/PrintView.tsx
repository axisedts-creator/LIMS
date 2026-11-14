'use client';
// C13.T19 PM-4 Print view (04-UI-UX PM-4; US-05.1). Real table with <th scope>, a tick column for lab staff and the hand-over footer; the "Print" button calls window.print().
// Print stylesheet (A4 portrait, 12 mm margins, black on white, no nav) lives in app/(app)/partner.css. LD-140: @lims/ui components only.
import { Button } from '@lims/ui/components/Button';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Dt } from '../common/ui';
import { codesText, sexAge } from '../common/format';
import type { Manifest } from '../common/types';

export interface PrintViewProps {
  labName: string;
  manifest: Manifest;
  partner: { name: string; partner_code: string };
  centre?: { name: string; code?: string } | undefined;
}

export function PrintView({ labName, manifest: m, partner, centre }: PrintViewProps) {
  return (
    <div className="partner-print">
      <div className="partner-no-print">
        <PageHeader title={`Print manifest ${m.manifest_no}`} helpKey="partners.manifest_print" actions={<Button onPress={() => window.print()}>Print</Button>} />
      </div>
      <header>
        <p>{labName}</p>
        <h2>Sample manifest</h2>
        <p className="partner-print-no">{m.manifest_no}</p>
        <p>{partner.name} ({partner.partner_code})</p>
        <p>Receiving centre: {centre?.name ?? m.receiving_centre?.name ?? '—'}</p>
        <p>Submitted: <Dt value={m.submitted_at} withTime /></p>
      </header>
      <table className="partner-print-table">
        <caption>Samples in manifest {m.manifest_no}</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Sample ref</th>
            <th scope="col">Patient name</th>
            <th scope="col">Sex/Age</th>
            <th scope="col">Tests</th>
            <th scope="col">Priority</th>
            <th scope="col">Collected at</th>
            <th scope="col">Received</th>
          </tr>
        </thead>
        <tbody>
          {m.lines.map((l) => (
            <tr key={l.id}>
              <th scope="row">{l.line_no}</th>
              <td>{l.partner_sample_ref ?? ''}</td>
              <td>{l.patient.full_name}</td>
              <td>{sexAge(l.patient)}</td>
              <td>{codesText(l.orderables.map((o) => o.code), 6)}</td>
              <td>{l.priority === 'urgent' ? 'Urgent' : 'Routine'}</td>
              <td><Dt value={l.collected_at} withTime /></td>
              <td>☐</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="partner-print-foot">
        <span>Handed over by ____________</span>
        <span>Received by ____________</span>
        <span>Time ____________</span>
      </footer>
    </div>
  );
}

import { Card } from '@lims/ui/components/Card';

export const metadata = { title: 'Open your report link' };

// portal.report_link_required: no data, no API call (02-TRD §3.5, review fix #31).
export default function ReportLinkRequired() {
  return (
    <>
      <h1>Your lab report</h1>
      <Card>
        <p>Open the link the lab sent you to view this report.</p>
      </Card>
    </>
  );
}

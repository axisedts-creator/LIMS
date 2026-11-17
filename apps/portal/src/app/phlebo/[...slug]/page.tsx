import { Card } from '@lims/ui/components/Card';

export const metadata = { title: 'Open the app' };

// portal.app_fallback for /phlebo/*: no data, no PHI, no API call (08 A13 D-38; C6-T37). Same page as /app/*.
export default function PhleboFallback() {
  return (
    <>
      <h1>Lab app</h1>
      <Card>
        <p>Open the app to continue.</p>
      </Card>
    </>
  );
}

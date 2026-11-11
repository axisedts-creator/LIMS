import { Card } from '@lims/ui/components/Card';

export const metadata = { title: 'Open the app' };

// portal.app_fallback: no data, no PHI, no API call (08 A13 D-38).
export default function AppFallback() {
  return (
    <>
      <h1>Lab app</h1>
      <Card>
        <p>Open the app to continue.</p>
      </Card>
    </>
  );
}

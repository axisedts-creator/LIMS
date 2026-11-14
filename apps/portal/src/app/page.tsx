import { Card } from '@lims/ui/components/Card';

export const metadata = { title: 'Lab report portal' };

// Data-free root (also the 2xx health URL the E2E runner waits for).
export default function Home() {
  return (
    <>
      <h1>Lab report portal</h1>
      <Card>
        <p>Open the link the lab sent you to view your report.</p>
      </Card>
    </>
  );
}

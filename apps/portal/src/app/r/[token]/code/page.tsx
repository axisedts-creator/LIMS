import { Card } from '@lims/ui/components/Card';
import { CodeForm } from '@/features/portal/CodeForm';
import { getChallenge } from '@/server/session';

export const metadata = { title: 'Enter your code' };

export default async function Code({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [channel, challengeId] = ((await getChallenge()) ?? 'sms:').split(':');
  const where = channel === 'email' ? 'the email address' : 'the mobile number';
  return (
    <>
      <h1>Enter your code</h1>
      <Card>
        <p>Code sent to {where} registered with the lab. It expires in 10 minutes.</p>
        <CodeForm key={challengeId} token={token} />
      </Card>
    </>
  );
}

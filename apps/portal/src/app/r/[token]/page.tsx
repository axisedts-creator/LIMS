import { Card } from '@lims/ui/components/Card';
import { sendCode } from '@/features/portal/actions';
import { ErrorNotice, RateNotice } from '@/features/portal/notices';

export const metadata = { title: 'View your lab report' };

type Q = { e?: string; m?: string; r?: string; ref?: string };

// Rendering this page never calls the API: link-preview bots must not trigger an OTP (T3).
export default async function Landing({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Q> }) {
  const { token } = await params;
  const q = await searchParams;
  const reissue = `/r/${encodeURIComponent(token)}/reissue`;

  if (q.r === '1') {
    return (
      <>
        <h1>Request a new link</h1>
        <Card>
          <p role="status">If this link was sent to you, a new one will arrive by the same method shortly.</p>
        </Card>
      </>
    );
  }
  if (q.e === 'rate') {
    return (
      <>
        <h1>View your lab report</h1>
        <RateNotice minutes={Math.min(Math.max(Number(q.m) || 60, 1), 24 * 60)} />
      </>
    );
  }
  if (q.e === 'error') {
    return (
      <>
        <h1>View your lab report</h1>
        <ErrorNotice reference={q.ref} />
      </>
    );
  }
  if (q.e === 'invalid') {
    return (
      <>
        <h1>View your lab report</h1>
        <Card>
          <p role="alert">This link is not valid. It may have expired or been replaced.</p>
          <form method="post" action={reissue}>
            <button type="submit" className="portal-btn portal-btn-primary">
              Request a new link
            </button>
          </form>
        </Card>
      </>
    );
  }
  return (
    <>
      <h1>View your lab report</h1>
      <Card>
        <p>For your security we will send a 6-digit code to the phone number or email the lab has for you.</p>
        <form action={sendCode.bind(null, token)}>
          <button type="submit" className="portal-btn portal-btn-primary">
            Send me a code
          </button>
        </form>
      </Card>
    </>
  );
}

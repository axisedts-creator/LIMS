import { Card } from '@lims/ui/components/Card';

export const minutesText = (m: number) => `Too many attempts. Please try again in ${m} ${m === 1 ? 'minute' : 'minutes'}.`;

/** Generic error with reference id (04-UI-UX §4 "Generic error"). */
export function ErrorNotice({ reference }: { reference?: string | undefined }) {
  return (
    <Card>
      <p role="alert">Something went wrong. Please try again later.</p>
      {reference && /^[0-9a-f-]{36}$/i.test(reference) ? <p>Reference: {reference}</p> : null}
    </Card>
  );
}

export function RateNotice({ minutes }: { minutes: number }) {
  return (
    <Card>
      <p role="alert">{minutesText(minutes)}</p>
    </Card>
  );
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kathmandu' });

// Tester stub for the kit `TokenSlip` (04-UI-UX §9.2: `{ labName, heading, big, lines, issuedAt }`, 80 mm print). Used only while the kit lacks it (see vitest.t-q4.config.ts).
export interface TokenSlipProps { labName: string; heading: string; big: string; lines: string[]; issuedAt: string }
export function TokenSlip({ labName, heading, big, lines, issuedAt }: TokenSlipProps) {
  return (
    <section aria-label="Token slip" data-testid="token-slip">
      <p>{labName}</p>
      <h2>{heading}</h2>
      <p>{big}</p>
      {lines.map((l) => <p key={l}>{l}</p>)}
      <time dateTime={issuedAt}>{issuedAt}</time>
    </section>
  );
}

import { DEFAULT_TZ, utcParts, type IsoUtc } from '../_shared/dates';

export interface TokenSlipProps {
  labName: string;
  heading: string;
  /** The token label (or app code), printed large. */
  big: string;
  lines: string[];
  issuedAt: IsoUtc;
}

// [CONV] 80 mm thermal roll width for print; kit tokens only (LD-140). React 19 hoists this <style> into <head>,
// so it never adds text inside the slip and PrintFrame's stylesheet clone picks it up.
const CSS = `
.lims-tokenslip { font-family: var(--lims-font-family-sans); color: var(--lims-neutral-900); background: var(--lims-neutral-0);
  border: 1px solid var(--lims-neutral-300); padding: var(--lims-space-3);
  max-width: 80mm; text-align: center; display: grid; gap: var(--lims-space-1); }
.lims-tokenslip > * { margin: 0; }
.lims-tokenslip__lab { font-weight: var(--lims-font-weight-semibold); }
.lims-tokenslip__heading { font-size: var(--lims-font-size-md-size); font-weight: var(--lims-font-weight-medium); }
.lims-tokenslip__big { font-family: var(--lims-font-family-mono); font-size: var(--lims-font-size-3xl-size); font-weight: var(--lims-font-weight-bold); }
.lims-tokenslip__line, .lims-tokenslip__time { font-size: var(--lims-font-size-sm-size); }
@media print {
  @page { size: 80mm auto; margin: 0; }
  .lims-tokenslip { width: 80mm; max-width: 80mm; border: 0; }
}`;

/** Printed queue/app-code slip (CR-C16-016; C16 04-UI-UX §9.2). Shows only these six fields — never patient name or phone. */
export function TokenSlip({ labName, heading, big, lines, issuedAt }: TokenSlipProps) {
  const p = utcParts(issuedAt, DEFAULT_TZ); // lab zone (CV §4.8)
  return (
    <section className="lims-tokenslip" aria-label="Token slip" data-testid="token-slip">
      <style href="lims-tokenslip" precedence="default">{CSS}</style>
      <p className="lims-tokenslip__lab">{labName}</p>
      <h2 className="lims-tokenslip__heading">{heading}</h2>
      <p className="lims-tokenslip__big">{big}</p>
      {lines.map((l, i) => (
        <p key={i} className="lims-tokenslip__line">{l}</p>
      ))}
      <time className="lims-tokenslip__time" dateTime={issuedAt}>{p ? `${p.date} ${p.time}` : issuedAt}</time>
    </section>
  );
}

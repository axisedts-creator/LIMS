// T0D-MSERIES-5 (LD-276, LD-251; board spec/program/design-m-series/M1-entry.png + sources/M1-entry.dc.html): the entry hero.
// Decoration only: every piece is aria-hidden except the plate, which keeps the source's one role="img" label.
// No inline style: the well wave is staggered by nth-child rules in apps/web shell.css; colours and radii are tokens there.
// markSrc: a same-origin URL of the round brand mark (apps/web passes MARK from core/shell/brand.ts).
// T0D-MSERIES-6 (LD-287, LD-290): optional photoSrc, a same-origin URL of the lab photo (apps/web passes HERO_PHOTO). When set, a decorative
// photo and its token gradient overlay are the first two children (behind everything else); omitted or empty, the output is the M5 hero.
// width/height are the pixel size of packages/ui/assets/brand/lab-hero.webp: update them when a larger file of the same name replaces it.

// the source's well pattern: (r + c) % 11 === 0 lights white, (3r + c) % 7 === 0 lights lime, the rest the pop lime
const WELLS = Array.from({ length: 96 }, (_, i) => {
  const r = Math.floor(i / 12);
  const c = i % 12;
  return (r + c) % 11 === 0 ? 'lims-auth-well lims-auth-well-w' : (r * 3 + c) % 7 === 0 ? 'lims-auth-well lims-auth-well-l' : 'lims-auth-well';
});

export function EntryHero({ markSrc, photoSrc }: { markSrc: string; photoSrc?: string }) {
  return (
    <>
      {photoSrc ? (
        <>
          <img className="lims-auth-photo" src={photoSrc} alt="" aria-hidden="true" loading="lazy" decoding="async" width={768} height={512} />
          <div className="lims-auth-photo-overlay" aria-hidden="true" />
        </>
      ) : null}
      <svg className="lims-auth-rings" viewBox="0 0 800 800" aria-hidden="true" focusable="false">
        <circle cx="400" cy="400" r="380" />
        <circle cx="400" cy="400" r="300" />
        <circle cx="400" cy="400" r="220" />
      </svg>
      <div className="lims-auth-scene" role="img" aria-label="Illustration: a 96-well plate tilted in 3D with wells lighting up in a wave">
        <div className="lims-auth-plate">
          <div className="lims-auth-slab lims-auth-slab-under" />
          <div className="lims-auth-slab lims-auth-slab-top">
            {WELLS.map((k, i) => (
              <span key={i} className={k} />
            ))}
          </div>
        </div>
      </div>
      <div className="lims-auth-mark" aria-hidden="true">
        <span className="lims-auth-mark-ring" />
        <img src={markSrc} alt="" />
      </div>
      <div className="lims-auth-chip lims-auth-chip-report" aria-hidden="true">
        <span className="lims-auth-chip-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        Report released
      </div>
      <div className="lims-auth-chip lims-auth-chip-sample" aria-hidden="true">
        <span className="lims-auth-chip-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 3c3.5 4.5 5.5 7 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 10 8.5 7.5 12 3z" />
          </svg>
        </span>
        Sample received
      </div>
      <div className="lims-auth-chip lims-auth-chip-qc" aria-hidden="true">
        <span className="lims-auth-chip-dot" />
        QC passed
      </div>
      <div className="lims-auth-tagline" aria-hidden="true">
        <span className="lims-auth-tagline-kicker">Tap. Test. Track.</span>{' '}
        <p>Every result, on time and on the record.</p>
      </div>
    </>
  );
}

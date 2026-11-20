import type { ReactNode } from 'react';
import { EntryHero } from '@lims/ui/components/EntryHero';
import { HERO_PHOTO, LOGO_ON_LIGHT, MARK } from '@/core/shell/brand';

// WEB-STYLE-1 (LD-198) + WEB-STYLE-2 (LD-201): split layout (form column + decorative brand panel); presentation only.
// T0D-MSERIES-2 (LD-251, 13-M-SERIES s5, board M1): the Metro Labs logo (self-hosted, the one accessible image) tops the form column.
// T0D-MSERIES-5 (LD-276, board M1-entry): two columns only, the form column and the M1 hero (plate, chips, mark, tagline).
// The old stepper panel, line art and slim band are gone. The board's footer links (Privacy policy, Terms of use,
// Help and status) have no route in contracts/routes.yaml, so they are left out (LD-250; .orchestra/cr/T0D-MSERIES-5.nonblocking.md).
// T0D-MSERIES-6 (LD-287, LD-290): the Metro Labs lab photo is the hero background on every entry screen (decorative, lazy).
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="lims-auth-page">
      <div className="lims-auth-main">
        <img className="lims-auth-logo" src={LOGO_ON_LIGHT} alt="Metro Labs" />
        {children}
      </div>
      <aside className="lims-auth-panel">
        <EntryHero markSrc={MARK} photoSrc={HERO_PHOTO} />
      </aside>
    </div>
  );
}

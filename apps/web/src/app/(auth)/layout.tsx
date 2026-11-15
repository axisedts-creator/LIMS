import type { ReactNode } from 'react';
import { AuthArt, AuthMark } from '@/features/admin/auth/AuthArt';

// WEB-STYLE-1 (LD-198) + WEB-STYLE-2 (LD-201): split layout (form column + decorative brand panel); presentation only.
// WEB-STYLE-3 (LD-205): panel content sits in .lims-auth-panel-body (vertical stepper, aligned with the form block).
// WEB-STYLE-4 (LD-213, founder): the panel carries inline SVG line art (AuthArt) and below 64rem a slim green band
// shows the lockup and a small art. Both are decoration (aria-hidden). Layout idea from Watermelon auth-05 only;
// nothing copied. No remote URL, no img element, no claims.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="lims-auth-page">
      <header className="lims-auth-band" aria-hidden="true">
        <div className="lims-lockup">
          <AuthMark />
          <p className="lims-wordmark">LIMS</p>
        </div>
        <AuthArt />
      </header>
      <div className="lims-auth-main">{children}</div>
      <aside className="lims-auth-panel" aria-hidden="true">
        <div className="lims-auth-panel-body">
          <p className="lims-auth-panel-title">From sample to report</p>
          <AuthArt />
          <ol className="lims-auth-steps">
            <li>Draft</li>
            <li>To collect</li>
            <li>To receive</li>
            <li>In progress</li>
            <li>To authorise</li>
            <li>Authorised</li>
            <li>Released</li>
          </ol>
        </div>
      </aside>
    </div>
  );
}

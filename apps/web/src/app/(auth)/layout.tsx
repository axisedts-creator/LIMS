import type { ReactNode } from 'react';

// WEB-STYLE-1 (LD-198) + WEB-STYLE-2 (LD-201): split layout (form column + decorative brand panel); presentation only.
// Layout idea from Watermelon auth-05 only; nothing copied. Panel: no image, no remote URL, no claims; aria-hidden.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="lims-auth-page">
      <div className="lims-auth-main">{children}</div>
      <aside className="lims-auth-panel" aria-hidden="true">
        <p className="lims-auth-panel-title">From sample to report</p>
        <ol className="lims-auth-steps">
          <li>Draft</li>
          <li>To collect</li>
          <li>To receive</li>
          <li>In progress</li>
          <li>To authorise</li>
          <li>Authorised</li>
          <li>Released</li>
        </ol>
      </aside>
    </div>
  );
}

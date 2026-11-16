// Metro Labs logo files (LD-251, 13-M-SERIES s3/s5): self-hosted from packages/ui/assets/brand (CSP img-src 'self'; no remote URL).
// Next turns a static image import into { src }, Vite (tests) into a URL string; both end up as a same-origin path.
import onDark from '../../../../../packages/ui/assets/brand/ml-logo-landscape-white.png';
import onLight from '../../../../../packages/ui/assets/brand/ml-logo-landscape.png';
import mark from '../../../../../packages/ui/assets/brand/ml-logo.png';

const url = (a: unknown): string => (typeof a === 'string' ? a : (a as { src: string }).src);

export const LOGO_ON_DARK = url(onDark);
export const LOGO_ON_LIGHT = url(onLight);
/** T0D-MSERIES-5 (LD-276, board M1-entry): the round brand mark on the entry hero. */
export const MARK = url(mark);

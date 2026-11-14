export interface DataUriImageProps {
  /** Only `data:image/png;base64,…` or `data:image/svg+xml;base64,…` (e.g. a server-rendered QR). */
  src: string;
  /** Mandatory, non-empty. */
  alt: string;
  'data-testid'?: string;
}

/** Strict: PNG or base64 SVG data URI, base64 alphabet only. SVG goes through <img>, which never runs its scripts (REQ-SEC-088). */
const SAFE = /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Renders an inline data-URI image; anything else (remote, relative, other types) renders nothing (REQ-SEC-141). */
export function DataUriImage({ src, alt, ...rest }: DataUriImageProps) {
  if (typeof src !== 'string' || !SAFE.test(src) || !alt) return null;
  return <img className="lims-data-image" src={src} alt={alt} {...rest} />;
}

// Link code (02-TRD §4.3): Crockford base32 without I L O U, 10 symbols shown XXXXX-XXXXX. Pure.
export const LINK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LINK_CODE_LENGTH = 10;

const VALID_RE = new RegExp(`^[${LINK_CODE_ALPHABET}]{${LINK_CODE_LENGTH}}$`);

/** Uppercase, strip '-' and whitespace, O->0, I/L->1. U is left alone (stays invalid). */
export const normalizeLinkCode = (raw: string): string =>
  raw.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

export const isValidLinkCode = (raw: string): boolean => VALID_RE.test(normalizeLinkCode(raw));

export const formatLinkCode = (normalised: string): string => `${normalised.slice(0, 5)}-${normalised.slice(5)}`;
